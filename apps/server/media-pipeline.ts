import {
  assetLookAgentPrompt,
  assetVisualPrompt,
  generationReviewPrompt,
  assertCharacterContent,
  characterContentTemplate,
  migrateLegacyContent,
  productionVisualPrompt,
  visualReviewPrompt,
  visualStyleKey,
  isSeriesMasterLook,
  isXianxiaLookLock,
  isUniversalXianxia,
  masterReferenceNote,
  xianxiaModules,
} from "../../packages/visual-style";
import {
  collapseLocationLooks,
  mergeLookAssets,
  lookRegistrySchema,
  lookRegistryAgentPrompt,
  nextIncompleteLookEpisode,
  requiredLooksForBeats,
} from "../../packages/look-registry";
import {
  seriesPlanSchema,
  storySchema,
  structured,
} from "../../packages/series";
import {
  castQwenVoices,
  mergeVoiceCards,
  hasCurrentVoicePolicy,
  seriesVoiceDna,
  fillMissingVoiceCards,
  pickShotVoice,
  textLen,
} from "./voice-casting";
import {
  supportsVideoAudio,
  videoAudioPrompt,
} from "../../packages/video-audio";
import { qwenVoices } from "./qwen-tts";
import { mediaProfile } from "../../packages/media-profiles";
import type { Runtime } from "./runtime";
import type { MediaReviewProgress } from "../../packages/progress";
import { parseResult } from "./connectors";
import {
  productionPrompt,
  timingManifest,
  validateShotTiming,
} from "../../packages/production";
import {
  reviewSchema,
  type Task,
  type Connection,
  type Artifact,
} from "../../packages/domain";
import {
  assetPlanSchema,
  isAssetImageLocked,
  voiceInBatch,
  storyboardSchema,
  timelineSchema,
  mediaBundle,
  type AssetPlan,
  type Storyboard,
  type Timeline,
  type MediaFile,
} from "../../packages/media";

export const lookImageConcurrency = 3;
const assetReviewPolicyVersion = 2;

async function runLookImagePool(
  ordered: AssetPlan["assets"],
  signal: AbortSignal,
  produce: (
    asset: AssetPlan["assets"][number],
    workSignal: AbortSignal,
  ) => Promise<void>,
) {
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  const tasks = new Map<string, Promise<void>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < lookImageConcurrency) {
        active += 1;
        resolve();
        return;
      }
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  const byId = new Map(ordered.map((asset) => [asset.id, asset]));
  const run = (asset: AssetPlan["assets"][number]) => {
    const cached = tasks.get(asset.id);
    if (cached) return cached;
    const job = (async () => {
      if (asset.sourceAssetId) {
        const source = byId.get(asset.sourceAssetId);
        if (source) await run(source);
      }
      await acquire();
      try {
        if (combined.aborted) throw Error("任务已中断");
        await produce(asset, combined);
      } finally {
        release();
      }
    })();
    tasks.set(asset.id, job);
    return job;
  };
  try {
    for (const asset of ordered.filter((item) => isSeriesMasterLook(item)))
      await run(asset);
    await Promise.all(ordered.map((asset) => run(asset)));
  } catch (error) {
    abort.abort();
    throw error;
  }
}

export class MediaPipeline {
  constructor(public runtime: Runtime) {}
  async execute(
    task: Task,
    attemptId: string,
    text: Connection,
    master: Connection,
    upstream: Artifact[],
    signal: AbortSignal,
  ) {
    const { store, media } = this.runtime;
    let feedback = task.instruction;
    try {
      for (let round = task.round; task.stage === 3 || round <= 3; round++) {
        this.assertCurrent(task, signal);
        store.updateTask(task.id, task.revision, "running");
        const edited =
          task.stage === 3 || round === task.round
            ? store.one<Artifact>(
                task.stage === 3
                  ? "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY rowid DESC LIMIT 1"
                  : "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='candidate' ORDER BY rowid DESC LIMIT 1",
                task.id,
                task.revision,
              )
            : null;
        const previous = edited ? mediaBundle(edited.content) : null;
        const bundle = await this.produce(
          task,
          attemptId,
          text,
          upstream,
          feedback,
          previous,
          signal,
          undefined,
          true,
        );
        this.assertCurrent(task, signal);
        const artifact = store.publish(
          task.id,
          task.revision,
          JSON.stringify(bundle, null, 2),
        );
        store.updateTask(task.id, task.revision, "reviewing");
        const reports: string[] = [];
        let passed = true;
        const ids = collectFileIds(bundle.data),
          files = ids.map((id) => media.files.get(id, task.projectId));
        const visual = files.filter((f) => ["image", "video"].includes(f.kind));
        const speechIds = new Set<string>();
        for (const v of "voices" in bundle.data ? bundle.data.voices : [])
          if (v.audioId && (!("assets" in bundle.data) || voiceInBatch(bundle.data, v))) speechIds.add(v.audioId);
        for (const shot of "shots" in bundle.data ? bundle.data.shots : [])
          if (shot.audioId) speechIds.add(shot.audioId);
        const nativeShots = ("shots" in bundle.data ? bundle.data.shots : []).filter(
          (shot) => shot.route === "native" && shot.videoId && shot.dialogue,
        );
        const review: MediaReviewProgress = {
          startedAt: new Date().toISOString(),
          step: "speech",
          current: "准备审核素材",
          speechDone: 0,
          speechTotal: speechIds.size + nativeShots.length,
          visualDone: 0,
          visualTotal: visual.length,
          summaryDone: false,
        };
        const saveReview = (step: MediaReviewProgress["step"], current: string) => {
          this.assertCurrent(task, signal);
          review.step = step;
          review.current = current;
          store.db.run("INSERT OR REPLACE INTO media_review_progress VALUES(?,?,?)", [
            task.id, task.revision, JSON.stringify(review),
          ]);
        };
        saveReview("speech", "准备声音转写");
        for (const shot of "shots" in bundle.data ? bundle.data.shots : [])
          if (shot.route === "native" && shot.videoId && shot.dialogue) {
            saveReview("speech", `${shot.title || shot.id} · 提取视频声音`);
            const audio = await media.files.nativeAudio(shot.videoId, signal);
            speechIds.add(audio.id);
          }
        review.speechTotal = speechIds.size;
        for (const id of speechIds) {
          saveReview("speech", files.find((f) => f.id === id)?.name || "视频原声");
          const transcript = await media.transcribe(id, signal);
          reports.push(`配音 ${id} 实际语音转写：${transcript}`);
          review.speechDone++;
          saveReview("speech", "声音转写已完成");
        }
        await this.runtime.reviewBatch(task, master, signal, async (progress, batchSignal) => {
          const abort = new AbortController();
          const reviewSignal = AbortSignal.any([batchSignal, abort.signal]);
          const active = new Map<string, string>();
          let next = 0;
          const visualReports: string[] = new Array(visual.length);
          const worker = async () => {
            while (next < visual.length && !reviewSignal.aborted) {
              const index = next++;
              const file = visual[index];
              this.assertCurrent(task, reviewSignal);
              active.set(file.id, file.name);
              saveReview("visual", `并发审核 ${active.size} 项：${[...active.values()].join("、")}`);
              try {
                const asset = bundle.type === "assets"
                  ? (bundle.data as AssetPlan).assets.find(a => a.imageId === file.id)
                  : undefined;
                if (asset && isAssetImageLocked(asset)) {
                  visualReports[index] = `${file.name}：已通过并锁定，复用审核结果`;
                  review.visualDone++;
                  active.delete(file.id);
                  saveReview("visual", `${file.name} 已锁定，跳过审核`);
                  continue;
                }
                const paths = await media.files.inspectFrames(file.id, reviewSignal);
                const criteria = bundle.type === "assets"
                  ? generationReviewPrompt(this.assetGenerationPrompt(asset, file.id))
                  : `检查构图、角色和画风一致性、主体错误、字幕可读性（若有）。${visualReviewPrompt(store.visualStyle(task.projectId))}`;
                const report = reviewSchema.parse(
                  parseResult(
                    await this.runtime.call(
                      task,
                      attemptId,
                      master,
                      `你是主控。审核附带的实际${file.kind === "video" ? "视频抽帧" : "图片"}。产物名称：${file.name}。${criteria}抽帧只能证明这些时刻，不要声称已看过全视频。${bundle.type === "assets" ? "只核验本图及以上提示词，不使用剧情、其他角色、历史审核意见作为附加要求。" : `任务要求：${feedback}。产物上下文：${JSON.stringify(bundle.data)}。元数据：${file.metadata}。`}返回 JSON {"pass":boolean,"feedback":"具体问题与原因"}。`,
                      reviewSignal,
                      paths,
                      progress,
                    ),
                  ),
                );
                this.assertCurrent(task, reviewSignal);
                if (bundle.type === "assets") {
                  for (const item of (bundle.data as AssetPlan).assets.filter(a => a.imageId === file.id)) {
                    item.imageReview = { policyVersion: assetReviewPolicyVersion, imageId: file.id, prompt: item.generationPrompt || "", ...report };
                    if (!report.pass) item.imageRepairFeedback = report.feedback;
                  }
                  // Persist each result before another review can fail or be interrupted.
                  store.db.run("UPDATE artifacts SET content=? WHERE id=?", [JSON.stringify(bundle), artifact.id]);
                  store.event(task.projectId, task.id, report.pass ? "review.asset.passed" : "review.asset.failed",
                    `${file.name}：${report.pass ? "已通过并锁定" : "未通过，将自动重试"}；${report.feedback}`);
                }
                visualReports[index] = `${file.name}：${report.feedback}`;
                if (!report.pass) passed = false;
                review.visualDone++;
                active.delete(file.id);
                saveReview("visual", active.size ? `并发审核 ${active.size} 项：${[...active.values()].join("、")}` : "本批图片 / 视频检查已完成");
              } catch (error) {
                abort.abort();
                throw error;
              }
            }
          };
          const results = await Promise.allSettled(
            Array.from({ length: Math.min(3, visual.length) }, () => worker()),
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          this.assertCurrent(task, reviewSignal);
          reports.push(...visualReports);
        });
        saveReview("summary", "检查素材完整性、剧本一致性和角色绑定");
        const summary = bundle.type === "assets"
          ? { pass: passed, feedback: passed ? "全部定妆图片已逐张通过并锁定，等待用户确认。" : "保留已通过图片，仅自动重试未通过图片。" }
          : reviewSchema.parse(
          parseResult(
            await this.runtime.call(
              task,
              attemptId,
              master,
              `你是主控。审核制作阶段的完整交付及实际媒体检查报告。${bundle.type === "assets" ? "定妆内容只按交付中每张图片的 generationPrompt 及其实际图片审核报告验收，不得追加独立禁词或天气、动作、美术标准；identity/state 是登记信息，不得仅因其关键词否决实际画面。缺少生成提示词时明确无法核验。" : ""}配音实际转写应与台词一致，漏字错词需指出；不要把转写声称为已确认音色或情绪，音色、语气和口型最终需要用户试听审片。检查素材齐全、剧本一致、分镜顺序和角色绑定。定妆与声音归属全剧；voiceBatchAssetIds 仅表示当前优先补齐的角色资产 ID。只要求本批角色对应成长阶段的声音完整，其余已有声音保留，尚待选型或生成不能阻塞本批；试听稿是独立试音，不能要求照抄单集台词。返回 JSON {"pass":boolean,"feedback":"完整审核结论与不确定项"}。\n上游：${JSON.stringify(upstream.map((a) => a.content))}\n交付：${JSON.stringify(bundle)}\n视觉和语音检查：${reports.join("\n")}\n媒体元数据：${JSON.stringify(files.map((f) => ({ name: f.name, metadata: f.metadata })))}\n用户要求：${feedback}`,
              signal,
            ),
          ),
        );
        passed = passed && summary.pass;
        review.summaryDone = true;
        saveReview("summary", passed ? "审核通过" : "审核完成，需修改");
        feedback =
          task.instruction +
          "\n" +
          summary.feedback +
          "\n" +
          reports.join("\n");
        this.assertCurrent(task, signal);
        store.event(
          task.projectId,
          task.id,
          passed ? "review.passed" : "review.failed",
          feedback,
        );
        store.db.run("UPDATE artifacts SET status=? WHERE id=?", [
          passed ? "reviewed" : "rejected",
          artifact.id,
        ]);
        if (passed) {
          store.invalidateAfter(task);
          store.updateTask(task.id, task.revision, "awaiting_user");
          break;
        }
        if (task.stage !== 3 && round === 3) {
          store.updateTask(
            task.id,
            task.revision,
            "needs_user",
            "已完成 3 轮自动返工，请查看媒体与审核意见",
          );
          break;
        }
        store.db.run("UPDATE tasks SET round=? WHERE id=? AND revision=?", [
          round + 1,
          task.id,
          task.revision,
        ]);
      }
      store.db.run("UPDATE attempts SET status='completed' WHERE id=?", [
        attemptId,
      ]);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (!signal.aborted && store.task(task.id).revision === task.revision) {
        store.updateTask(
          task.id,
          task.revision,
          error.includes("预算")
            ? "budget_blocked"
            : /制作验收|配音超过|单段/.test(error)
              ? "needs_user"
              : "provider_blocked",
          error,
        );
        store.event(task.projectId, task.id, "task.error", error);
      }
      store.db.run("UPDATE attempts SET status='failed' WHERE id=?", [
        attemptId,
      ]);
    }
  }
  async prepareCharacterContent(task: Task, asset: AssetPlan["assets"][number], assets: AssetPlan["assets"], stylePrompt: string, signal: AbortSignal) {
    if (asset.kind !== "character" || !(stylePrompt.startsWith("STYLE LOCK —") || isXianxiaLookLock(stylePrompt))) return;
    asset.prompt = migrateLegacyContent(asset.prompt);
    if (asset.promptFormat === "character-content-v1") {
      assertCharacterContent(asset.prompt);
      return;
    }
    const result = parseResult(await this.runtime.call(
      task, crypto.randomUUID(), this.runtime.store.binding("文本模型"),
      `只将以下单个角色的已有设定转写为 CONTENT，不改变身份、外貌、服装、年龄，不使用其他角色的设定；未知信息不编造。删除旧描述中的构图背景和光影，内容不含 cinematic、史诗、仙气、电影感等风格词。填写全部字段，无则写 none。单独规划的武器在 Other accessories 写 no weapon。仅返回 JSON {"prompt":"填好的 CONTENT 全文"}。模板：\n${characterContentTemplate}\n固定画风（不输出、不修改）：\n${stylePrompt}\n该角色设定：${JSON.stringify({ name: asset.name, prompt: asset.prompt, identity: asset.identity, state: asset.state })}\n独立道具名称：${JSON.stringify(assets.filter(a => a.kind === "prop").map(a => a.name))}`,
      signal,
    ));
    if (!result || typeof result !== "object" || !("prompt" in result) || typeof result.prompt !== "string") throw Error("角色 CONTENT 转写未返回有效文本");
    assertCharacterContent(result.prompt);
    this.assertCurrent(task, signal);
    asset.prompt = result.prompt;
    asset.promptFormat = "character-content-v1";
  }
  assetReferences(task: Task, asset: AssetPlan["assets"][number], assets: AssetPlan["assets"], baseImageId?: string) {
    const style = this.runtime.store.visualStyle(task.projectId);
    const ids: string[] = [];
    const notes: string[] = [];
    const add = (id: string, role: string) => {
      this.runtime.media.files.get(id, task.projectId);
      let index = ids.indexOf(id);
      if (index < 0) { ids.push(id); index = ids.length - 1; }
      notes.push(`Reference ${index + 1}: ${role}`);
    };
    if (asset.sourceAssetId) {
      const source = assets.find(a => a.id === asset.sourceAssetId);
      if (asset.kind === "scene" && source?.kind !== "scene") throw Error("场景定妆只能使用场景参考，不能使用人物或道具参考");
      if (!source?.imageId || source.id === asset.id) throw Error(`资产 ${asset.name} 的基础参考未完成或引用自身`);
      add(source.imageId, `the source design for ${asset.sourceUsage || "view"}; preserve its geometry, identity and materials, show only the requested asset or view. Do not independently redesign it.`);
    }
    if (baseImageId) add(baseImageId, "the same asset identity in another state; retain its defining design.");
    if (!isUniversalXianxia(style) && style.referenceImageId && !isSeriesMasterLook(asset))
      add(
        style.referenceImageId,
        xianxiaModules(style)
          ? masterReferenceNote(asset.kind)
          : "production style only: match the selected visual style, shape language and rendering finish; do not copy this subject, face, age, hair color, costume, pose or background into a different asset.",
      );
    return { ids, notes: style.prompt.startsWith("UNIVERSAL XIANXIA STYLE") ? "" : notes.length ? `\n\nREFERENCE ROLES\n${notes.join("\n")}` : "" };
  }

  assetGenerationPrompt(asset: AssetPlan["assets"][number] | undefined, imageId: string) {
    return asset?.candidateSpecs?.[imageId]?.prompt ||
      (asset?.imageId === imageId ? asset.generationPrompt : undefined) ||
      this.runtime.store.one<{ prompt: string }>(
        "SELECT prompt FROM media_jobs WHERE outputId=? AND kind='image' ORDER BY rowid DESC LIMIT 1", imageId,
      )?.prompt || "";
  }

  async reviewAssetImage(task: Task, asset: AssetPlan["assets"][number], imageId: string, referenceIds: string[], signal: AbortSignal) {
    const { store, media } = this.runtime;
    const paths = [media.files.get(imageId, task.projectId).path, ...referenceIds.map(id => media.files.get(id, task.projectId).path)];
    return reviewSchema.parse(parseResult(await this.runtime.call(task, crypto.randomUUID(), store.binding("主模型"),
      `审核实际图片，第一张为候选，后续为生成参考。${generationReviewPrompt(this.assetGenerationPrompt(asset, imageId))}返回 JSON {"pass":boolean,"feedback":"逐项引用生成要求、具体画面证据和不确定项"}。`, signal, paths)));
  }

  async retryAsset(task: Task, assetId: string, signal: AbortSignal) {
    if (task.stage !== 3) throw Error("仅定妆资产支持单张重新生成");
    if (["running", "reviewing", "coordinating"].includes(task.status))
      throw Error("任务正在执行，请先中断再重试单张定妆");
    const { store, media } = this.runtime;
    const artifact = store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY rowid DESC LIMIT 1",
      task.id,
      task.revision,
    );
    if (!artifact) throw Error("还没有可重试的定妆产物");
    const bundle = mediaBundle(artifact.content);
    const data = assetPlanSchema.parse(bundle?.data);
    const asset = data.assets.find((a) => a.id === assetId);
    if (!asset) throw Error("资产不存在");
    const p = store.project(task.projectId);
    const style = store.visualStyle(task.projectId);
    const library = store.assetLibrary(task.projectId);
    const base = asset.baseLibraryId
      ? library.find((a) => a.libraryId === asset.baseLibraryId)
      : undefined;
    this.assertCurrent(task, signal);
    if (asset.promptFormat !== "character-content-v1" &&
        asset.promptFormat !== "prop-content-v1" &&
        asset.promptFormat !== "scene-content-v1")
      await this.prepareCharacterContent(task, asset, data.assets, style.prompt, signal);
    if (
      xianxiaModules(style) &&
      !isUniversalXianxia(style) &&
      !isSeriesMasterLook(asset) &&
      !style.referenceImageId
    )
      throw Error("没有主参考（沈不言定妆）不能入库正式资产");
    const refs = this.assetReferences(task, asset, data.assets,
      base?.generationStyleKey === visualStyleKey(style) ? base.imageId : undefined);
    const generationPrompt =
      assetVisualPrompt(style, asset, data.assets) + refs.notes;
    const candidateId = await media.ensure(
      task.id,
      task.revision,
      "image",
      generationPrompt,
      refs.ids,
      { aspect: p.aspect },
      signal,
      undefined,
      true,
    );
    asset.candidates = [
      ...new Set([
        ...(asset.candidates || []),
        ...(asset.imageId ? [asset.imageId] : []),
        candidateId,
      ]),
    ];
    asset.candidateSpecs = { ...asset.candidateSpecs, [candidateId]: {
      prompt: generationPrompt, styleKey: visualStyleKey(style),
      styleVersion: style.version || style.id, referenceIds: refs.ids,
    } };
    const next = { type: "assets" as const, data };
    store.publish(task.id, task.revision, JSON.stringify(next, null, 2));
    const report = await this.reviewAssetImage(
      task,
      asset,
      candidateId,
      refs.ids,
      signal,
    );
    asset.candidateSpecs[candidateId].passed = report.pass;
    store.publish(task.id, task.revision, JSON.stringify(next, null, 2));
    store.event(task.projectId, task.id, report.pass ? "review.asset.passed" : "review.asset.failed", `${asset.name}：${report.feedback}`);
    this.assertCurrent(task, signal);
    if (!report.pass)
      throw Error(`图片未通过验收，已追加候选，未替换正式定妆：${report.feedback}`);
    store.event(
      task.projectId,
      task.id,
      "media.retry",
      `${asset.name} 已按锁定规格抽卡，正式定妆未自动覆盖。`,
    );
    return next;
  }
  async selectAsset(task: Task, assetId: string, imageId: string) {
    if (task.stage !== 3) throw Error("仅定妆资产支持选择候选");
    const { store } = this.runtime;
    if (store.downstream(task).some(t => ["running", "reviewing", "coordinating"].includes(t.status)))
      throw Error("下游正在制作，请先中断再选择全剧定妆");
    const artifact = store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY rowid DESC LIMIT 1",
      task.id,
      task.revision,
    );
    if (!artifact) throw Error("还没有可选择的定妆产物");
    const bundle = mediaBundle(artifact.content);
    const data = assetPlanSchema.parse(bundle?.data);
    const asset = data.assets.find((a) => a.id === assetId);
    if (!asset) throw Error("资产不存在");
    const pool = [
      ...(asset.candidates || []),
      ...(asset.imageId ? [asset.imageId] : []),
    ];
    if (!pool.includes(imageId)) throw Error("只能选择本次抽卡产生的候选图");
    const spec = asset.candidateSpecs?.[imageId];
    if (spec?.passed === false) throw Error("这张候选图未通过画风或内容验收，请重新生成");
    if ((spec?.styleKey || asset.generationStyleKey) !== visualStyleKey(store.visualStyle(task.projectId)))
      throw Error("候选图属于旧画风，请按当前画风重新生成");
    this.runtime.media.files.get(imageId, task.projectId);
    if (asset.imageId === imageId) return { type: "assets" as const, data };
    asset.imageId = imageId;
    asset.selectedCandidateId = imageId;
    delete asset.libraryId;
    if (spec) {
      asset.generationPrompt = spec.prompt;
      asset.generationStyleKey = spec.styleKey;
      asset.generationStyleVersion = spec.styleVersion;
      asset.generationReferenceIds = spec.referenceIds;
    }
    asset.imageReview = spec?.passed === true
      ? { imageId, prompt: spec.prompt, pass: true, feedback: "单张候选审核通过" }
      : undefined;
    const next = { type: "assets" as const, data };
    store.db.run("UPDATE artifacts SET status='superseded' WHERE taskId=? AND revision=? AND status IN ('approved','reviewed')", [task.id, task.revision]);
    store.invalidateAfter(task);
    store.updateTask(task.id, task.revision, "paused");
    store.publish(task.id, task.revision, JSON.stringify(next, null, 2));
    store.event(
      task.projectId,
      task.id,
      "media.select",
      `${asset.name} 已选中候选，重新审核确认后作为全剧定妆；相关关键帧和视频已标为待更新。`,
    );
    return next;
  }
  /** Scheduling scope only: the asset and voice libraries remain series-wide. */
  voiceBatchAssets(task: Task, data: AssetPlan) {
    const { store } = this.runtime;
    const tasks = store.tasks(task.projectId);
    const episodes = tasks.filter(t => t.stage === 6).sort((a, b) => (a.episode || 1) - (b.episode || 1));
    const episode = (episodes.find(t => t.status !== "approved") || episodes.at(-1))?.episode || 1;
    const scriptTask = tasks.find(t => t.stage === 2 && t.episode === episode);
    const script = scriptTask && store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='approved' ORDER BY createdAt DESC LIMIT 1",
      scriptTask.id, scriptTask.revision,
    );
    const manifest = script && timingManifest(script.content)?.episodes.find(e => e.id === `EP${String(episode).padStart(3, "0")}`);
    if (!manifest) return [];
    const speakers = new Set(manifest.beats.flatMap(b => b.performance?.dialogue || [])
      .filter(d => d.text.trim()).map(d => d.speaker.trim()));
    const registry = store.lookRegistry(task.projectId);
    const required = registry ? requiredLooksForBeats(registry, manifest.sourceStepIds || [], episode === 1) : null;
    return data.assets.filter(a => a.kind === "character" && speakers.has(a.name) &&
      (!required || required.some(r => r.id === a.id)));
  }

  async retryVoices(
    task: Task,
    character: string | undefined,
    signal: AbortSignal,
    rewritePortrait = false,
  ) {
    if (task.stage !== 3) throw Error("仅定妆与资产阶段支持角色声音试听");
    if (["running", "reviewing", "coordinating"].includes(task.status))
      throw Error("任务正在执行，请先中断再重新生成试听");
    const { store, media } = this.runtime;
    if (store.downstream(task).some((t) => this.runtime.active.has(t.id)))
      throw Error("下游正在制作，请先中断再修改角色声音");
    const artifact = store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY rowid DESC LIMIT 1",
      task.id,
      task.revision,
    );
    const bundle = artifact && mediaBundle(artifact.content);
    if (!bundle || bundle.type !== "assets")
      throw Error("尚无角色资产方案，请先生成定妆方案");
    const data = assetPlanSchema.parse(bundle.data);
    const batchAssets = character
      ? data.assets.filter(a => a.kind === "character" && a.name === character)
      : this.voiceBatchAssets(task, data);
    data.voiceBatchAssetIds = batchAssets.map(a => a.id);
    const targets = [...new Set(batchAssets.map(a => a.name))];
    const inBatch = (v: AssetPlan["voices"][number]) => batchAssets.some(a => a.name === v.character && (a.growthStage || "") === (v.growthStage || ""));
    if (!targets.length) throw Error("没有可生成试听的角色");
    const connection = media.connection("speech");
    let voices =
      connection.provider === "qwen-tts"
        ? connection.model.includes("VoiceDesign")
          ? ["VoiceDesign"]
          : qwenVoices
        : Array.isArray(connection.settings?.voices)
          ? connection.settings.voices.map(String)
          : [String(connection.settings?.voice || "alloy")];
    if (connection.provider === "elevenlabs") {
      const response = await media.request(connection, "/voices", signal);
      voices =
        ((await response.json()) as any).voices?.map((v: any) => v.voice_id) ||
        [];
    }
    if (!voices.length) throw Error("语音连接没有可用音色");
    let changed = false;
    const completeCard = (sample: (typeof data.voices)[number]) =>
      !!(
        sample.status === "ready" &&
        sample.voicePortrait &&
        sample.sampleText &&
        sample.instructions &&
        hasCurrentVoicePolicy(sample)
      );
    if (connection.provider === "qwen-tts") {
      const toWrite = targets.filter((name) => {
        const assets = batchAssets.filter((a) => a.name === name);
        return rewritePortrait || assets.some((asset) => !data.voices.some(
          (sample) => sample.character === name &&
            (sample.growthStage || "") === (asset.growthStage || "") &&
            completeCard(sample),
        ));
      });
      if (toWrite.length) {
        const shots: Storyboard["shots"] = [];
        const design = connection.model.includes("VoiceDesign");
        if (rewritePortrait)
          data.voices = data.voices.filter(
            (v) => !inBatch(v),
          );
        const bound = rewritePortrait
          ? []
          : store.approvedVoices(task.projectId, connection.id);
        const borrow = rewritePortrait
          ? []
          : store
              .allApprovedVoices(task.projectId)
              .filter(
                (v) =>
                  !bound.some(
                    (s) =>
                      s.character === v.character && s.audioId === v.audioId,
                  ),
              );
        const filled = await fillMissingVoiceCards(
          castQwenVoices({ ...data, assets: batchAssets }, shots, toWrite, design, bound, borrow),
          data.assets,
          shots,
          storyBible(store.upstream(task)),
          async (prompt) =>
            parseResult(
              await this.runtime.call(
                task,
                crypto.randomUUID(),
                store.binding("文本模型"),
                prompt,
                signal,
              ),
            ),
        );
        data.voices = mergeVoiceCards(data.voices, filled);
      }
      if (!rewritePortrait)
        data.voices = data.voices.map((sample) => {
          if (!inBatch(sample) || !completeCard(sample))
            return sample;
          const { audioId: _dropped, ...kept } = sample;
          return kept;
        });
    }
    if (connection.provider !== "qwen-tts") {
      const missing = batchAssets.filter((asset) => asset.kind === "character" &&
        targets.includes(asset.name) && (rewritePortrait || !data.voices.some(
          (sample) => sample.character === asset.name &&
            (sample.growthStage || "") === (asset.growthStage || "") &&
            sample.status === "ready" && sample.sampleText.trim(),
        )));
      if (missing.length) {
        const plan = assetPlanSchema.pick({ voices: true }).parse(parseResult(
          await this.runtime.call(task, crypto.randomUUID(), store.binding("文本模型"),
            `${seriesVoiceDna}\n你是全剧配音设计。根据以下全剧角色及成长阶段的稳定身份各生成一份独立试听稿，不依赖任何单集分镜台词。只从可用 voice ID ${JSON.stringify(voices)} 中选择。返回 JSON {"voices":[{"character":"角色原名","growthStage":"资产原成长阶段","voice":"可用ID","sampleText":"符合该角色口吻的独立试听稿"}]}。角色资产：${JSON.stringify(missing)}。全剧设定：${storyBible(store.upstream(task))}`,
            signal),
        ));
        for (const asset of missing) {
          const sample = plan.voices.find((v) => v.character === asset.name &&
            (v.growthStage || "") === (asset.growthStage || "") && v.sampleText.trim());
          if (!sample) throw Error(`角色 ${asset.name}（${asset.growthStage || "默认阶段"}）缺少试听稿`);
          data.voices = data.voices.filter((v) => !(v.character === asset.name &&
            (v.growthStage || "") === (asset.growthStage || "")));
          data.voices.push({ ...sample, status: "ready", audioId: undefined });
        }
      }
    }
    const selected = data.voices.filter(
      (v) => inBatch(v) && v.status === "ready",
    );
    this.assertCurrent(task, signal);
    store.updateTask(task.id, task.revision, "running", "正在生成角色声音试听");
    try {
      for (const [index, sample] of selected.entries()) {
        const chosenVoice = voices.includes(sample.voice)
          ? sample.voice
          : voices[0];
        if (
          connection.provider === "qwen-tts" &&
          (!sample.voicePortrait || textLen(sample.sampleText) < 80)
        )
          throw Error(
            `${sample.character} 还没有声音卡或长句试听稿，不能用短台词试听`,
          );
        this.assertCurrent(task, signal);
        store.event(
          task.projectId,
          task.id,
          "media.voice",
          `试听 ${index + 1}/${selected.length}：${sample.character} · ${chosenVoice}`,
        );
        const audioId = await media.ensure(
          task.id,
          task.revision,
          "speech",
          sample.sampleText,
          [],
          { voice: chosenVoice, instructions: sample.instructions },
          signal,
          undefined,
          true,
        );
        this.assertCurrent(task, signal);
        sample.audioId = audioId;
        sample.voice = chosenVoice;
        if (!changed) {
          store.db.run(
            "UPDATE artifacts SET status='superseded' WHERE taskId=? AND revision=? AND status IN ('reviewed','approved')",
            [task.id, task.revision],
          );
          store.invalidateAfter(task);
          changed = true;
        }
        store.publish(
          task.id,
          task.revision,
          JSON.stringify({ type: "assets", data }),
        );
      }
      store.updateTask(
        task.id,
        task.revision,
        "needs_user",
        "试听已更新，可播放检查；继续执行阶段可交主控重新审核",
      );
      store.event(
        task.projectId,
        task.id,
        "media.voice",
        `已完成 ${selected.length} 个声音试听；全剧角色按成长阶段保持一致声线，不匹配的声线等待处理。定妆图保持不变`,
      );
      return { type: "assets", data };
    } catch (error) {
      if (store.task(task.id).revision === task.revision)
        store.updateTask(
          task.id,
          task.revision,
          "needs_user",
          `试听生成未全部完成，已完成结果保留：${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    }
  }
  assertCurrent(task: Task, signal: AbortSignal) {
    if (
      signal.aborted ||
      this.runtime.store.task(task.id).revision !== task.revision
    )
      throw Error("任务已中断或修订已变化");
  }
  async produce(
    task: Task,
    attemptId: string,
    text: Connection,
    upstream: Artifact[],
    feedback: string,
    edited: any,
    signal: AbortSignal,
    checkpoint?: (type: string, data: any) => void,
    preserveLookPlan = false,
  ) {
    const { store, media } = this.runtime,
      p = store.project(task.projectId);
    let style = store.visualStyle(task.projectId);
    const rules = store.productionRules(p.id);
    const visualOptions = {
      aspect: p.aspect,
      visualStyleKey: visualStyleKey(style),
      visualRevision: store.settings(p.id).visualRevision || 0,
    };
    const episode = upstream
      .map((a) =>
        store.task(a.taskId).stage === 2
          ? timingManifest(a.content)?.episodes[0]
          : undefined,
      )
      .find(Boolean);
    const context = `画幅 ${p.aspect}，风格 ${productionVisualPrompt(style)}。每集最终时长 ${rules.minSeconds}～${rules.maxSeconds} 秒；具体镜头以本集已确认剧本和文字分镜为准，不强制场景数量、反应比例或叙事模板。\n资产必须分开记录 identity（不变外貌）与 state（服装、年龄、伤势、能力阶段）。天气、昼夜、临时湿衣和剧情动作不属于 state，写入关键帧 imagePrompt。分镜必须额外提供 beatId（剧本时间清单中的节拍 ID）、sceneId、imagePrompt（静态构图，不含连续动作）、motionPrompt（单一明确动作、运动方向与结果）、soundPrompt（环境和动作音效，明确时间点，无需则写无）、musicPrompt（是否需要配乐及其情绪、乐器与音量，无需则写无）、camera（景别、机位、轴线、视线）、startState、endState。prompt 保留镜头摘要。每镜头有叙事用途，所有镜头按节拍连续排列，同一节拍镜头时长之和严格等于节拍时长。动作需分清原因、执行和反应；保持跨镜头人物位置、视线、服饰伤势一致。strategy 仅支持 single（单段）或 tail-chain（超过供应商时限时以前段实际末帧接续），不要虚构其他供应商能力。用户要求：${feedback}。已确认上游：${JSON.stringify(upstream.map((a) => a.content))}`;
    const checkShots = (shots: Storyboard["shots"]) => {
      const issues = validateShotTiming(shots, rules, episode);
      if (issues.length) throw Error(`制作验收不通过：${issues.join("；")}`);
    };
    const checkVoice = (shot: Storyboard["shots"][number]) => {
      if (
        shot.audioId &&
        JSON.parse(media.files.get(shot.audioId).metadata).duration >
          shot.duration + 0.05
      )
        throw Error(
          `镜头 ${shot.id} 配音超过 ${shot.duration} 秒，请局部精简对白或重新分配节拍；不会自动延长镜头。`,
        );
    };
    const bundleAt = (type: string) =>
      upstream.map((a) => mediaBundle(a.content)).find((b) => b?.type === type)
        ?.data;
    const ask = async (prompt: string) =>
      parseResult(
        await this.runtime.call(
          task,
          attemptId,
          text,
          prompt + "\n" + context,
          signal,
        ),
      );
    const saveProgress =
      checkpoint ||
      ((type: string, data: any) => {
        store.publish(
          task.id,
          task.revision,
          JSON.stringify({ type, data }, null, 2),
        );
      });
    if (task.stage === 3) {
      media.connection("image");
      const library = store.assetLibrary(task.projectId);
      let registry = store.lookRegistry(task.projectId);
      const lookAsk = async (prompt: string) =>
        parseResult(
          await this.runtime.call(task, attemptId, text, prompt, signal),
        );
      const approvedAt = (stage: number) => {
        const found = store.tasks(task.projectId).find((item) => item.stage === stage);
        return found
          ? store.one<Artifact>(
              "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='approved' ORDER BY createdAt DESC LIMIT 1",
              found.id,
              found.revision,
            )
          : null;
      };
      const story = (() => {
        const art = approvedAt(7);
        return art ? structured(art.content, storySchema) : null;
      })();
      // Older approved stories predate the look registry. Backfill before
      // scheduling, otherwise the model is explicitly asked for "无新项".
      if (!registry?.entities?.length && story) {
        store.event(task.projectId, task.id, "workflow.part", "完整故事缺少外观登记，正在补齐全剧外观名册。");
        const result = lookRegistrySchema.safeParse(await lookAsk(
          lookRegistryAgentPrompt(story.bible, JSON.stringify(story.chapters)),
        ));
        this.assertCurrent(task, signal);
        if (!result.success)
          throw Error("外观登记生成不完整，请恢复执行以重新整理人物、场景和道具名册。");
        registry = result.data;
        store.patchSettings(task.projectId, { lookRegistry: registry });
        store.event(task.projectId, task.id, "workflow.part", "全剧外观名册已补齐，开始生成定妆资产。");
      }
      const plan = (() => {
        const art = approvedAt(1);
        if (!art) return null;
        try {
          return seriesPlanSchema.parse(JSON.parse(art.content));
        } catch {
          return null;
        }
      })();
      const existing =
        edited?.type === "assets" && Array.isArray(edited.data?.assets)
          ? edited.data.assets
          : [];
      const batch: { episode: number; required: { id: string; kind: string; name: string }[] } = preserveLookPlan && !edited?.data?.extendLookPlan && existing.length
        ? { episode: 1, required: existing.map((a: AssetPlan["assets"][number]) => ({ id: a.id, kind: a.kind, name: a.name })) }
        : nextIncompleteLookEpisode(
        registry,
        plan,
        story,
        existing.map((asset: { id: string }) => asset.id),
      );
      const complete =
        existing.length > 0 &&
        batch.required.every((look) =>
          existing.some((asset: { id: string }) => asset.id === look.id),
        );
      const planned = complete
        ? edited.data
        : await lookAsk(
            assetLookAgentPrompt(
              style.prompt,
              JSON.stringify(
                library.filter(
                  (a) => a.generationStyleKey === visualStyleKey(style),
                ),
              ),
              JSON.stringify(registry || { entities: [] }),
            ) +
              `同一场景的局部和另一视角不要单独建资产。换装用 variantKind=costume，破败用 form，成长阶段用 growth。按集增量出定妆，全剧共用同一份资产表：已有资产保留，不重画；本批是第 ${batch.episode} 集。本批必须提供：${batch.required.map((look) => look.id).join("、") || "无新项"}。后集才出现的换装、破败、成长变体不要现在出图。完整故事：${JSON.stringify(upstream.filter((a) => store.task(a.taskId).stage === 7).map((a) => a.content))}`,
          );
      const lockedIds = new Set(existing.filter((a: AssetPlan["assets"][number]) => isAssetImageLocked(a) && a.generationStyleKey === visualStyleKey(style)).map((a: AssetPlan["assets"][number]) => a.id));
      const mergedAssets = mergeLookAssets<AssetPlan["assets"][number]>(existing, (planned.assets || []).filter((a: AssetPlan["assets"][number]) => !lockedIds.has(a.id)));
      if (!mergedAssets.length)
        throw Error("模型未返回任何定妆资产，请检查外观登记后恢复执行。" +
          (typeof planned.summary === "string" ? `模型说明：${planned.summary}` : ""));
      const data: AssetPlan = assetPlanSchema.parse({
        ...planned,
        lookPlanRevision: task.revision,
        extendLookPlan: false,
        assets: collapseLocationLooks(
          mergedAssets,
        ),
      });
      for (const look of batch.required)
        if (!data.assets.some((asset) => asset.id === look.id && asset.kind === look.kind))
          throw Error(`制作验收：本集定妆 ${look.id} 未提供`);
      saveProgress("assets", data);
      const ordered: typeof data.assets = [];
      const pending = new Set<string>();
      const visited = new Set<string>();
      const visit = (asset: typeof data.assets[number]) => {
        if (visited.has(asset.id)) return;
        if (pending.has(asset.id)) throw Error("资产基础参考存在循环");
        pending.add(asset.id);
        if (asset.sourceAssetId) {
          const source = data.assets.find(a => a.id === asset.sourceAssetId);
          if (!source) throw Error(`资产基础参考不存在：${asset.sourceAssetId}`);
          visit(source);
        }
        pending.delete(asset.id); visited.add(asset.id); ordered.push(asset);
      };
      data.assets.forEach(visit);
      ordered.sort(
        (a, b) =>
          (isSeriesMasterLook(a) ? 0 : 1) - (isSeriesMasterLook(b) ? 0 : 1),
      );
      store.event(
        task.projectId,
        task.id,
        "media.looks",
        isUniversalXianxia(style)
          ? `定妆按最多 ${lookImageConcurrency} 路并发生图；角色各用自己的造型，场景严格无人。`
          : `定妆按最多 ${lookImageConcurrency} 路并发生图；沈不言主参考先出，其余并行。`,
      );
      let contentTurn = Promise.resolve();
      await runLookImagePool(ordered, signal, async (asset, workSignal) => {
        if (isAssetImageLocked(asset) && asset.generationStyleKey === visualStyleKey(style)) return;
        if (asset.imageId && asset.imageReview?.pass === false &&
            asset.imageReview.imageId === asset.imageId &&
            asset.imageReview.policyVersion !== assetReviewPolicyVersion &&
            asset.generationStyleKey === visualStyleKey(style)) return;
        const retryRejected = asset.imageReview?.pass === false && asset.imageReview.imageId === asset.imageId;
        // A rejected library image must enter generation, not keep reloading
        // the same library version on every automatic retry.
        if (retryRejected) delete asset.libraryId;

        const base = asset.baseLibraryId
          ? library.find((a) => a.libraryId === asset.baseLibraryId)
          : undefined;
        if (asset.baseLibraryId && (!base || base.kind !== asset.kind))
          throw Error("制作验收：基础资产引用不存在或类型不同");
        if (asset.libraryId) {
          const saved = library.find((a) => a.libraryId === asset.libraryId);
          if (!saved) throw Error("制作验收：引用的资产版本不属于此作品");
          if (
            asset.identity !== saved.identity ||
            asset.state !== saved.state ||
            asset.kind !== saved.kind
          )
            throw Error("制作验收：复用资产的身份或状态已改变，请创建新版本");
          asset.imageId = saved.imageId;
          asset.generationPrompt = saved.generationPrompt;
          asset.generationStyleVersion = saved.generationStyleVersion;
          asset.generationStyleKey = saved.generationStyleKey;
          asset.generationReferenceIds = saved.generationReferenceIds;
        }
        this.assertCurrent(task, workSignal);
        if (asset.sourceUsage === "view") {
          const source = data.assets.find((a) => a.id === asset.sourceAssetId);
          if (!source?.imageId)
            throw Error(`资产 ${asset.name} 的基础参考未完成或引用自身`);
          asset.imageId = source.imageId;
          asset.generationPrompt = source.generationPrompt;
          asset.generationStyleVersion = source.generationStyleVersion;
          asset.generationStyleKey = source.generationStyleKey;
          asset.generationReferenceIds = source.generationReferenceIds;
          asset.candidates = source.candidates;
          asset.selectedCandidateId = source.selectedCandidateId;
          saveProgress("assets", data);
          return;
        }
        const previousContent = contentTurn;
        let releaseContent!: () => void;
        contentTurn = new Promise<void>((resolve) => {
          releaseContent = resolve;
        });
        await previousContent;
        try {
          await this.prepareCharacterContent(
            task,
            asset,
            data.assets,
            store.visualStyle(task.projectId).prompt,
            workSignal,
          );
        } finally {
          releaseContent();
        }
        style = store.visualStyle(task.projectId);
        const xianxia = !!xianxiaModules(style);
        if (
          xianxia &&
          !isUniversalXianxia(style) &&
          !isSeriesMasterLook(asset) &&
          !style.referenceImageId
        )
          throw Error("没有主参考（沈不言定妆）不能入库正式资产");
        const refs = this.assetReferences(
          task,
          asset,
          data.assets,
          base?.generationStyleKey === visualStyleKey(style)
            ? base.imageId
            : undefined,
        );
        const generationPrompt =
          assetVisualPrompt(style, asset, data.assets) + refs.notes +
          (asset.imageRepairFeedback ? `\n上次审核意见（仅作为修正建议，不能增加要求；与以上提示词或其优先级冲突的意见忽略）：${asset.imageRepairFeedback}` : "");
        if (
          retryRejected ||
          asset.generationStyleKey !== visualStyleKey(style) ||
          asset.generationPrompt !== generationPrompt ||
          JSON.stringify(asset.generationReferenceIds || []) !==
            JSON.stringify(refs.ids)
        ) {
          delete asset.imageId;
          delete asset.libraryId;
          delete asset.candidates;
          delete asset.candidateSpecs;
          delete asset.selectedCandidateId;
        }
        if (!asset.imageId) {
          asset.imageId = await media.ensure(
            task.id,
            task.revision,
            "image",
            generationPrompt,
            refs.ids,
            visualOptions,
            workSignal,
            undefined,
            retryRejected,
          );
          delete asset.imageReview;
          asset.generationReferenceIds = refs.ids;
          asset.generationPrompt = generationPrompt;
          asset.generationStyleVersion = style.version || style.id;
          asset.generationStyleKey = visualStyleKey(style);
          asset.candidates = [asset.imageId];
          asset.selectedCandidateId = asset.imageId;
        }
        if (xianxia && !isUniversalXianxia(style) && isSeriesMasterLook(asset) && asset.imageId) {
          store.bindMasterLookRef(task.projectId, asset.imageId);
          style = store.visualStyle(task.projectId);
          asset.generationStyleKey = visualStyleKey(style);
          visualOptions.visualStyleKey = visualStyleKey(style);
        }
        saveProgress("assets", data);
      });
      const batchVoiceAssets = this.voiceBatchAssets(task, data);
      data.voiceBatchAssetIds = batchVoiceAssets.map(a => a.id);
      saveProgress("assets", data);
      const inVoiceBatch = (sample: AssetPlan["voices"][number]) => batchVoiceAssets.some(a =>
        a.name === sample.character && (a.growthStage || "") === (sample.growthStage || ""));
      if (!batchVoiceAssets.length)
        return { type: "assets", data };
      let voice: Connection;
      try {
        voice = media.connection("speech");
      } catch (error) {
        throw Error(
          `定妆图片已生成并保存；声音试听待配置：请将“语音模型”绑定到支持独立配音的 API 连接后继续。${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let voices =
        voice.provider === "qwen-tts"
          ? voice.model.includes("VoiceDesign")
            ? ["VoiceDesign"]
            : qwenVoices
          : Array.isArray(voice.settings?.voices)
            ? (voice.settings!.voices as string[])
            : [String(voice.settings?.voice || "alloy"), "nova", "onyx"];
      if (voice.provider === "elevenlabs") {
        const data = (await (
          await media.request(voice, "/voices", signal)
        ).json()) as any;
        voices = (data.voices || []).map((v: any) => v.voice_id);
        if (!voices.length) throw Error("语音供应商未返回可用声音");
      }
      const approvedVoices = store.approvedVoices(task.projectId, voice.id);
      const borrowedVoices = store
        .allApprovedVoices(task.projectId)
        .filter(
          (v) =>
            !approvedVoices.some(
              (s) => s.character === v.character && s.audioId === v.audioId,
            ),
        );
      const missingVoiceAssets = batchVoiceAssets.filter((asset) => asset.kind === "character" &&
        !data.voices.some((sample) => sample.character === asset.name &&
          (sample.growthStage || "") === (asset.growthStage || "") &&
          sample.status === "ready" && sample.sampleText.trim()));
      if (missingVoiceAssets.length && voice.provider !== "qwen-tts") {
        const plan = await lookAsk(
          `${seriesVoiceDna}\n你是配音 Agent。根据全剧稳定身份，为以下角色的每个成长阶段各提供 2 个不同声音的试听候选（不足则 1 个），不依赖任何单集分镜，仅从可用 voice ID ${JSON.stringify(voices.slice(0, 30))} 中选择。返回 JSON {"voices":[{"character":"角色名字","growthStage":"资产原成长阶段","voice":"可用ID","sampleText":"符合稳定身份的独立试听稿"}]}。角色：${JSON.stringify(missingVoiceAssets)}。全剧设定：${storyBible(upstream)}`,
        );
        const plannedVoices = assetPlanSchema.pick({ voices: true }).parse(plan).voices;
        for (const asset of missingVoiceAssets) {
          if (!plannedVoices.some((sample) => sample.character === asset.name &&
            (sample.growthStage || "") === (asset.growthStage || "") && sample.sampleText.trim()))
            throw Error(`制作验收：角色 ${asset.name}（${asset.growthStage || "默认阶段"}）声音试听方案为空`);
        }
        data.voices = [...data.voices.filter((sample) => !missingVoiceAssets.some((asset) =>
          asset.name === sample.character && (asset.growthStage || "") === (sample.growthStage || ""))),
          ...plannedVoices];
        saveProgress("assets", data);
      }
      const selectedCharacters = new Set<string>();
      data.voices = data.voices.filter((sample) => {
        const saved = approvedVoices.find(
          (v) => v.character === sample.character &&
            (v.growthStage || "") === (sample.growthStage || ""),
        );
        if (!saved) return true;
        const identity = JSON.stringify([sample.character, sample.growthStage || ""]);
        if (selectedCharacters.has(identity)) return false;
        selectedCharacters.add(identity);
        Object.assign(sample, saved);
        return true;
      });
      if (voice.provider === "qwen-tts") {
        const design = voice.model.includes("VoiceDesign");
        const filled = await fillMissingVoiceCards(
          castQwenVoices(
            { ...data, assets: batchVoiceAssets },
            [],
            undefined,
            design,
            approvedVoices,
            borrowedVoices,
          ),
          data.assets,
          [],
          storyBible(upstream),
          lookAsk,
        );
        data.voices = mergeVoiceCards(data.voices, filled);
        saveProgress("assets", data);
        const missing = data.voices.filter((v) => inVoiceBatch(v) && v.status === "needs_voice");
        if (missing.length)
          throw Error(
            `制作验收：角色声音待选型：${missing.map((v) => v.character + "：" + v.castingNote).join("；")}`,
          );
      }
      for (const sample of data.voices) {
        if (!inVoiceBatch(sample) || sample.status === "not_required") continue;
        this.assertCurrent(task, signal);
        if (!voices.includes(sample.voice))
          throw Error(`声音 ${sample.voice} 不在供应商可用列表中`);
        if (!sample.audioId)
          sample.audioId = await media.ensure(
            task.id,
            task.revision,
            "speech",
            sample.sampleText,
            [],
            { voice: sample.voice, instructions: sample.instructions },
            signal,
          );
        saveProgress("assets", data);
      }
      return { type: "assets", data };
    }
    const assets = assetPlanSchema.parse(bundleAt("assets"));
    if (assets.assets.some(a => a.generationStyleKey && a.generationStyleKey !== visualStyleKey(style)))
      throw Error("全剧定妆尚未按当前画风生成并确认，请先完成定妆");
    const resetShotStyle = (shot: Storyboard["shots"][number]) => {
      if (shot.generationStyleKey !== visualStyleKey(style)) {
        delete shot.imageId;
        delete shot.videoId;
        delete shot.sourceAudioId;
        shot.draftImage = false;
      }
      shot.generationStyleKey = visualStyleKey(style);
    };
    const speechOptions = (shot: Storyboard["shots"][number]) => {
      const selected = pickShotVoice(assets, shot);
      if (media.connection("speech").provider === "qwen-tts" && !selected)
        throw Error(`制作验收：${shot.speaker} 缺少已选定的合适声线`);
      if (
        media.connection("speech").provider === "qwen-tts" &&
        selected?.sampleText &&
        shot.dialogue.trim() === selected.sampleText.trim()
      )
        throw Error(`镜头 ${shot.id} 不能使用试听稿作为台词`);
      shot.voice = selected?.voice || shot.voice || "alloy";
      return { voice: shot.voice, instructions: selected?.instructions || "" };
    };
    if (task.stage === 4) {
      media.connection("image");
      media.connection("speech");
      const data: Storyboard = storyboardSchema.parse(
        edited?.type === "storyboard"
          ? edited.data
          : (!feedback.trim() && bundleAt("shot-plan")) ||
              (await ask(
                `你是分镜 Agent。以已确认文字分镜为基础，应用用户要求及审核返工意见，返回修改后的完整镜头方案；保留未涉及的内容，遵守剧本节拍和现有资产约束。返回 JSON {"summary":"说明","shots":[{"id":"镜头ID","title":"标题","prompt":"画面动作","duration":6,"assetIds":[],"dialogue":"台词","speaker":"角色","route":"separate"}]}。不要返回 imageId、audioId、videoId、previewId 等旧素材文件 ID，修改后的媒体由系统重新生成。`,
              )),
      );
      checkShots(data.shots);
      if (edited?.type !== "storyboard" && feedback.trim()) {
        delete data.previewId;
        for (const shot of data.shots) {
          delete shot.imageId;
          delete shot.audioId;
          delete shot.videoId;
          delete shot.sourceAudioId;
          shot.draftImage = false;
        }
      }
      saveProgress("storyboard", data);
      for (const shot of data.shots) {
        this.assertCurrent(task, signal);
        resetShotStyle(shot);
        const refs = shot.assetIds.map((id) => {
          const a = assets.assets.find((a) => a.id === id);
          if (!a?.imageId) throw Error(`镜头引用的资产 ${id} 不存在`);
          return a.imageId;
        });
        if (!shot.imageId && refs.length) {
          shot.imageId = refs[0];
          shot.draftImage = true;
        }
        if (!shot.imageId)
          shot.imageId = await media.ensure(
            task.id,
            task.revision,
            "image",
            `${productionVisualPrompt(style)}。严格依据参考资产保持人物外观。${shot.imagePrompt || shot.prompt}。${shot.camera}。起始状态：${shot.startState}`,
            refs,
            visualOptions,
            signal,
          );
        if (shot.dialogue && !shot.audioId) {
          shot.voice =
            shot.voice ||
            assets.voices.find((v) => v.character === shot.speaker)?.voice ||
            "alloy";
          shot.audioId = await media.ensure(
            task.id,
            task.revision,
            "speech",
            shot.dialogue,
            [],
            speechOptions(shot),
            signal,
          );
        }
        saveProgress("storyboard", data);
        checkVoice(shot);
      }
      const rendered = await media.files.render(
        p.id,
        task.id,
        task.revision,
        timelineSchema.parse({ ...data, subtitles: true }),
        true,
        signal,
      );
      data.previewId = rendered.exportId;
      data.summary +=
        "\n本阶段为节奏预演：标有草稿的画面使用已确认资产占位，用于确认对白、节拍和剪辑时长，不代表正式关键帧或动画效果。";
      return { type: "storyboard", data };
    }
    if (task.stage === 5) {
      const data: Storyboard = storyboardSchema.parse(
        edited?.type === "production" ? edited.data : bundleAt("storyboard"),
      );
      checkShots(data.shots);
      saveProgress("production", data);
      const video = media.connection("video");
      for (const shot of data.shots) {
        this.assertCurrent(task, signal);
        resetShotStyle(shot);
        if (shot.draftImage) {
          delete shot.imageId;
          delete shot.videoId;
          delete shot.sourceAudioId;
          shot.draftImage = false;
        }
        let imageFeedback = feedback;
        for (
          let imageRound = 0;
          !shot.videoId && imageRound < 4;
          imageRound++
        ) {
          if (!shot.imageId) {
            const refs = shot.assetIds
              .map((id) => assets.assets.find((a) => a.id === id)?.imageId)
              .filter((id): id is string => !!id);
            shot.imageId = await media.ensure(
              task.id,
              task.revision,
              "image",
              `${productionVisualPrompt(style)}。${shot.imagePrompt || shot.prompt}。${shot.camera}。${shot.startState}。局部修订：${imageFeedback}`,
              refs,
              visualOptions,
              signal,
            );
            saveProgress("production", data);
          }
          if (!shot.videoId) {
            const review = reviewSchema.parse(
              parseResult(
                await this.runtime.call(
                  task,
                  attemptId,
                  store.binding("主模型"),
                  `你是主控。视频生成前审核实际关键帧，检查参考角色身份、构图、视线、场景和起始状态。只返回 JSON {"pass":boolean,"feedback":"定位镜头的问题"}。镜头：${JSON.stringify(shot)}。${context}`,
                  signal,
                  [media.files.get(shot.imageId).path],
                ),
              ),
            );
            if (!review.pass) {
              delete shot.imageId;
              saveProgress("production", data);
              imageFeedback = `${feedback}；${review.feedback}；关键帧修订 ${imageRound + 1}`;
              store.event(
                p.id,
                task.id,
                "review.keyframe",
                `${shot.id} 关键帧未通过，局部返工：${review.feedback}`,
              );
              if (imageRound === 3)
                throw Error(
                  `制作验收不通过：关键帧 ${shot.id}：${review.feedback}`,
                );
            } else break;
          }
        }
        if (shot.dialogue && !shot.audioId && shot.route !== "native") {
          shot.audioId = await media.ensure(
            task.id,
            task.revision,
            "speech",
            shot.dialogue,
            [],
            speechOptions(shot),
            signal,
          );
        }
        checkVoice(shot);
        if (shot.videoId) continue;
        if (shot.route === "native" && !video.settings?.nativeAudio)
          throw Error(
            `镜头 ${shot.title} 选择了原生音画，但视频连接未声明此能力。请调整路线或连接。`,
          );
        if (shot.route === "lipsync") media.connection("lipsync");
        const max = Number(mediaProfile(video, "video").maxDuration);
        if (!Number.isFinite(max) || max < 1 || max > 600)
          throw Error("视频连接 maxDuration 需要在 1 到 600 秒之间");
        if (shot.duration > max && shot.route === "native") {
          shot.route = shot.dialogue ? "lipsync" : "separate";
          if (shot.route === "lipsync") {
            media.connection("lipsync");
            if (!shot.audioId)
              shot.audioId = await media.ensure(
                task.id,
                task.revision,
                "speech",
                shot.dialogue,
                [],
                speechOptions(shot),
                signal,
              );
          }
          store.event(
            p.id,
            task.id,
            "media.route",
            "长镜头已切换为完整配音与分段视频，保持台词连续。",
          );
        }
        const withAudio = supportsVideoAudio(video);
        if (!withAudio)
          store.event(
            p.id,
            task.id,
            "media.audio",
            "当前视频连接未声明同步音频能力，本段仍需后期补音效与音乐",
          );
        const prompt = `${productionVisualPrompt(style)}。${shot.motionPrompt || shot.prompt}。${shot.camera}。起始状态：${shot.startState}；结束状态：${shot.endState}。${shot.route === "native" ? `角色 ${shot.speaker} 用 ${shot.voice} 声音准确说出：${shot.dialogue}` : "保持画面连续，禁止字幕和无关文字。"} ${withAudio ? videoAudioPrompt(shot) : ""} ${feedback}`;
        if (shot.duration > max && shot.route !== "native") {
          if (shot.strategy === "single")
            throw Error(
              `镜头 ${shot.id} 超过供应商单段 ${max} 秒，请拆镜头或选择末帧接续。`,
            );
          const count = Math.ceil(shot.duration / max),
            duration = shot.duration / count,
            clips = [];
          let reference = shot.imageId!;
          for (let n = 0; n < count; n++) {
            this.assertCurrent(task, signal);
            const id = await media.ensure(
              task.id,
              task.revision,
              "video",
              `${prompt}。这是连续镜头的第 ${n + 1}/${count} 段，保持相同人物、场景和运动方向，不要重复开场动作。`,
              [reference],
              {
                ...visualOptions,
                duration,
                ...(withAudio ? { generateAudio: true } : {}),
              },
              signal,
            );
            clips.push({ id, duration });
            if (n < count - 1)
              reference = (await media.files.tailFrame(id, duration, signal))
                .id;
          }
          shot.videoId = await media.files.stitch(
            p.id,
            task.id,
            task.revision,
            clips,
            signal,
          );
        } else
          shot.videoId = await media.ensure(
            task.id,
            task.revision,
            "video",
            prompt,
            [shot.imageId!],
            {
              ...visualOptions,
              duration: shot.duration,
              ...(withAudio ? { generateAudio: true } : {}),
            },
            signal,
          );
        if (withAudio && shot.route !== "native") {
          if (JSON.parse(media.files.get(shot.videoId!).metadata).hasAudio)
            shot.sourceAudioId = (
              await media.files.nativeAudio(shot.videoId!, signal, true)
            ).id;
          else
            store.event(
              p.id,
              task.id,
              "media.audio",
              `镜头 ${shot.title} 请求了同步声音，但视频没有音轨，需要后期补音`,
            );
        }
        if (shot.route === "lipsync" && shot.audioId)
          shot.videoId = await media.ensure(
            task.id,
            task.revision,
            "lipsync",
            shot.dialogue,
            [shot.videoId, shot.audioId],
            speechOptions(shot),
            signal,
          );
        if (shot.route === "native") shot.audioId = undefined;
        saveProgress("production", data);
      }
      return { type: "production", data };
    }
    const production = storyboardSchema.parse(bundleAt("production"));
    const data: Timeline = timelineSchema.parse(
      edited?.type === "timeline"
        ? edited.data
        : {
            ...production,
            ...((await ask(
              `你是后期音乐音效 Agent。根据本集内容给出纯音乐与适量氛围音效生成要求。已有 sourceAudioId 的镜头已带同步音效或音乐，不要重复叠加；全片镜头均带同步声音时，默认 musicPrompt 与 soundPrompt 返回空字符串，仅在用户明确要求补充时提供。只返回 JSON {"summary":"剪辑说明","musicPrompt":"配乐提示词","soundPrompt":"背景氛围音效提示词","musicVolume":0.18,"soundVolume":0.25,"subtitles":true,"subtitleSize":32}。不要重写镜头数据。`,
            )) as Record<string, unknown>),
          },
    );
    if (edited?.type === "timeline") {
      data.shots = data.shots.map(shot => {
        if (shot.generationStyleKey === visualStyleKey(style)) return shot;
        const current = production.shots.find(s => s.id === shot.id);
        if (!current?.videoId || current.generationStyleKey !== visualStyleKey(style))
          throw Error(`镜头 ${shot.id} 尚未按当前画风生成，请先完成正式镜头`);
        return { ...shot, imageId: current.imageId, videoId: current.videoId,
          sourceAudioId: current.sourceAudioId, audioId: current.audioId,
          draftImage: false, generationStyleKey: current.generationStyleKey };
      });
    }
    checkShots(data.shots);
    saveProgress("timeline", data);
    if (
      data.shots.some(
        (s) => !s.videoId || (s.dialogue && !s.audioId && s.route !== "native"),
      )
    ) {
      const regenerated = await this.produce(
        { ...task, stage: 5 },
        attemptId,
        text,
        upstream,
        feedback,
        { type: "production", data },
        signal,
        (_type, progress) =>
          saveProgress("timeline", { ...data, shots: progress.shots }),
      );
      data.shots = storyboardSchema.parse(regenerated.data).shots;
    }
    const length = data.shots.reduce((s, t) => s + t.duration, 0);
    if (data.musicPrompt && !data.musicId)
      data.musicId = await media.ensure(
        task.id,
        task.revision,
        "music",
        data.musicPrompt,
        [],
        { duration: length },
        signal,
      );
    if (data.soundPrompt && !data.soundId)
      data.soundId = await media.ensure(
        task.id,
        task.revision,
        "sound",
        data.soundPrompt,
        [],
        { duration: Math.min(30, length) },
        signal,
      );
    saveProgress("timeline", data);
    const exported = await media.files.render(
      p.id,
      task.id,
      task.revision,
      data,
      false,
      signal,
    );
    Object.assign(data, exported);
    return { type: "timeline", data };
  }
}
function storyBible(artifacts: Artifact[]) {
  for (const artifact of artifacts) {
    try {
      const value = JSON.parse(artifact.content);
      if (value?.type === "story" && typeof value.bible === "string")
        return value.bible;
    } catch {}
  }
  return "";
}
function collectFileIds(data: any): string[] {
  const ids = new Set<string>();
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "imageReview") continue;
      if (
        typeof x === "string" &&
        [
          "imageId",
          "audioId",
          "videoId",
          "musicId",
          "soundId",
          "previewId",
          "exportId",
          "dialogueTrackId",
          "mixedTrackId",
        ].includes(k)
      )
        ids.add(x);
      else if (typeof x === "object") walk(x);
    }
  }
  walk(data);
  return [...ids];
}

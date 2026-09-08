import { assetVisualPrompt } from "../../packages/visual-style";
import {
  castQwenVoices,
  fillMissingVoiceCards,
  textLen,
} from "./voice-casting";
import {
  supportsVideoAudio,
  videoAudioPrompt,
} from "../../packages/video-audio";
import { qwenVoices } from "./qwen-tts";
import { mediaProfile } from "../../packages/media-profiles";
import type { Runtime } from "./runtime";
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
  storyboardSchema,
  timelineSchema,
  mediaBundle,
  type AssetPlan,
  type Storyboard,
  type Timeline,
  type MediaFile,
} from "../../packages/media";

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
      for (let round = task.round; round <= 3; round++) {
        this.assertCurrent(task, signal);
        store.updateTask(task.id, task.revision, "running");
        const edited =
          round === task.round
            ? store.one<Artifact>(
                "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='candidate' ORDER BY createdAt DESC LIMIT 1",
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
          if (v.audioId) speechIds.add(v.audioId);
        for (const shot of "shots" in bundle.data ? bundle.data.shots : [])
          if (shot.audioId) speechIds.add(shot.audioId);
        for (const shot of "shots" in bundle.data ? bundle.data.shots : [])
          if (shot.route === "native" && shot.videoId && shot.dialogue) {
            const audio = await media.files.nativeAudio(shot.videoId, signal);
            speechIds.add(audio.id);
          }
        for (const id of speechIds) {
          const transcript = await media.transcribe(id, signal);
          reports.push(`配音 ${id} 实际语音转写：${transcript}`);
        }
        for (const file of visual) {
          this.assertCurrent(task, signal);
          const paths = await media.files.inspectFrames(file.id, signal);
          const report = reviewSchema.parse(
            parseResult(
              await this.runtime.call(
                task,
                attemptId,
                master,
                `你是主控。审核附带的实际${file.kind === "video" ? "视频抽帧" : "图片"}。产物名称：${file.name}。检查构图、角色和画风一致性、主体错误、字幕可读性（若有）。抽帧只能证明这些时刻，不要声称已看过全视频。任务要求：${feedback}。产物上下文：${JSON.stringify(bundle.data)}。元数据：${file.metadata}。返回 JSON {"pass":boolean,"feedback":"具体问题与原因"}。`,
                signal,
                paths,
              ),
            ),
          );
          reports.push(`${file.name}：${report.feedback}`);
          if (!report.pass) passed = false;
        }
        const summary = reviewSchema.parse(
          parseResult(
            await this.runtime.call(
              task,
              attemptId,
              master,
              `你是主控。审核制作阶段的完整交付及实际媒体检查报告。配音实际转写应与台词一致，漏字错词需指出；不要把转写声称为已确认音色或情绪，音色、语气和口型最终需要用户试听审片。检查素材齐全、剧本一致、分镜顺序和角色绑定。返回 JSON {"pass":boolean,"feedback":"完整审核结论与不确定项"}。\n上游：${JSON.stringify(upstream.map((a) => a.content))}\n交付：${JSON.stringify(bundle)}\n视觉和语音检查：${reports.join("\n")}\n媒体元数据：${JSON.stringify(files.map((f) => ({ name: f.name, metadata: f.metadata })))}\n用户要求：${feedback}`,
              signal,
            ),
          ),
        );
        passed = passed && summary.pass;
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
        if (round === 3) {
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
  async retryAsset(task: Task, assetId: string, signal: AbortSignal) {
    if (task.stage !== 3) throw Error("仅定妆资产支持单张重新生成");
    if (["running", "reviewing", "coordinating"].includes(task.status))
      throw Error("任务正在执行，请先中断再重试单张定妆");
    const { store, media } = this.runtime;
    const artifact = store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY createdAt DESC LIMIT 1",
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
    const generationPrompt = assetVisualPrompt(style, asset, data.assets);
    asset.imageId = await media.ensure(
      task.id,
      task.revision,
      "image",
      generationPrompt,
      base?.imageId ? [base.imageId] : [],
      { aspect: p.aspect },
      signal,
      undefined,
      true,
    );
    asset.generationPrompt = generationPrompt;
    asset.generationStyleVersion = style.version || style.id;
    delete asset.libraryId;
    const next = { type: "assets" as const, data };
    store.publish(task.id, task.revision, JSON.stringify(next, null, 2));
    store.event(
      task.projectId,
      task.id,
      "media.retry",
      `${asset.name} 已按当前画风重新生成，旧图保留在素材库。`,
    );
    return next;
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
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY createdAt DESC LIMIT 1",
      task.id,
      task.revision,
    );
    const bundle = artifact && mediaBundle(artifact.content);
    if (!bundle || bundle.type !== "assets")
      throw Error("尚无角色资产方案，请先生成定妆方案");
    const data = assetPlanSchema.parse(bundle.data);
    const characters = [
      ...new Set([
        ...data.assets.filter((a) => a.kind === "character").map((a) => a.name),
        ...data.voices.map((v) => v.character),
      ]),
    ];
    const targets = character
      ? characters.filter((name) => name === character)
      : characters;
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
        sample.instructions
      );
    if (connection.provider === "qwen-tts") {
      const toWrite = targets.filter((name) => {
        const sample = data.voices.find((v) => v.character === name);
        if (sample?.status === "not_required") return false;
        return rewritePortrait || !sample || !completeCard(sample);
      });
      if (toWrite.length) {
        const shotPlan = store
          .upstream(task)
          .map((a) => mediaBundle(a.content))
          .find((b) => b?.type === "shot-plan");
        if (!shotPlan) throw Error("缺少已确认文字分镜，不能编造角色试听台词");
        const shots = storyboardSchema.parse(shotPlan.data).shots;
        const design = connection.model.includes("VoiceDesign");
        if (rewritePortrait)
          data.voices = data.voices.filter(
            (v) => !toWrite.includes(v.character),
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
          castQwenVoices(data, shots, toWrite, design, bound, borrow),
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
        data.voices = [
          ...data.voices.filter((v) => !toWrite.includes(v.character)),
          ...filled,
        ];
      }
      if (!rewritePortrait)
        data.voices = data.voices.map((sample) => {
          if (!targets.includes(sample.character) || !completeCard(sample))
            return sample;
          const { audioId: _dropped, ...kept } = sample;
          return kept;
        });
    }
    for (const name of targets) {
      if (!data.voices.some((v) => v.character === name)) {
        if (connection.provider === "qwen-tts")
          throw Error(`角色 ${name} 没有可生成的声音画像`);
        data.voices.push({
          character: name,
          voice: voices[0],
          sampleText: (() => {
            const plan = store
              .upstream(task)
              .map((a) => mediaBundle(a.content))
              .find((b) => b?.type === "shot-plan");
            const line =
              plan &&
              storyboardSchema
                .parse(plan.data)
                .shots.find((s) => s.speaker === name && s.dialogue.trim())
                ?.dialogue;
            if (!line)
              throw Error(`角色 ${name} 没有已确认台词，不能编造试听内容`);
            return line;
          })(),
          instructions: "",
          castingNote: "",
          status: "ready",
          voiceIdentityKey: "",
        });
      }
    }
    const selected = data.voices.filter(
      (v) => targets.includes(v.character) && v.status === "ready",
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
        `已完成 ${selected.length} 个声音试听；无台词角色不配音，不匹配的声线等待处理。定妆图保持不变`,
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
  ) {
    const { store, media } = this.runtime,
      p = store.project(task.projectId),
      style = store.visualStyle(task.projectId);
    const rules = store.productionRules(p.id);
    const episode = upstream
      .map((a) =>
        store.task(a.taskId).stage === 2
          ? timingManifest(a.content)?.episodes[0]
          : undefined,
      )
      .find(Boolean);
    const context = `画幅 ${p.aspect}，风格 ${style.prompt}。每集最终时长 ${rules.minSeconds}～${rules.maxSeconds} 秒；具体镜头以本集已确认剧本和文字分镜为准，不强制场景数量、反应比例或叙事模板。\n资产必须分开记录 identity（不变外貌）与 state（服装、年龄、伤势、能力阶段）。分镜必须额外提供 beatId（剧本时间清单中的节拍 ID）、sceneId、imagePrompt（静态构图，不含连续动作）、motionPrompt（单一明确动作、运动方向与结果）、soundPrompt（环境和动作音效，明确时间点，无需则写无）、musicPrompt（是否需要配乐及其情绪、乐器与音量，无需则写无）、camera（景别、机位、轴线、视线）、startState、endState。prompt 保留镜头摘要。每镜头有叙事用途，所有镜头按节拍连续排列，同一节拍镜头时长之和严格等于节拍时长。动作需分清原因、执行和反应；保持跨镜头人物位置、视线、服饰伤势一致。strategy 仅支持 single（单段）或 tail-chain（超过供应商时限时以前段实际末帧接续），不要虚构其他供应商能力。用户要求：${feedback}。已确认上游：${JSON.stringify(upstream.map((a) => a.content))}`;
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
      const data: AssetPlan = assetPlanSchema.parse(
        edited?.type === "assets"
          ? edited.data
          : await ask(
              `你是角色与资产 Agent。提取本集实际需要的角色、场景、道具，生成定妆提示词；角色图是单角色，不把多人拼在同一图。画风必须遵守：${style.prompt}。每项填写 promptFormat="visual-description-v1"。prompt 是一段可直接用于生图的完整中文画面描述，合并该资产全部可见身份、服饰、状态、姿态和场景信息，各写一次，约150～300字；identity 与 state 用于资产库记录，不会再次拼入生图输入，所以其中影响外观的信息必须完整体现在 prompt。用正向描述表达表情和气质，不堆叠同义禁令。不要写通用画风词、渲染词或中英双语翻译，程序会原样添加作品画风。美术表现严格使用当前画风，不重复加入真人写真或过时的写实渲染要求，不要改写成二维插画、水墨、赛璐璐或Q版，也不要写成任何现有动画角色的翻版。角色定妆只画身体、脸、头发和身上的衣服。已经单独列为 prop 的物件不要画进角色图：有佩剑资产则角色定妆无剑、不握剑、腰侧不挂剑。道具图是该物件的唯一外观来源，不要为了好看把道具画进角色定妆。本次只规划图像资产，voices 返回空数组；声音试听会在图像完成后独立规划。返回 JSON：{"summary":"说明","assets":[{"id":"稳定ID","name":"名字","kind":"character或scene或prop","promptFormat":"visual-description-v1","prompt":"完整中文画面描述","identity":"不变外貌","state":"当前外观状态"}],"voices":[{"character":"角色名字","voice":"可用ID","sampleText":"该角色一句适合试听的台词"}]}。从文字分镜 assetIds 提取全部需求并保持 ID 一致。已有资产可通过 libraryId 引用，必须选择外观与状态都匹配的版本；新增状态创建独立资产，并用 baseLibraryId 指定基础参考版本，不覆盖旧版。每项填写 identity 与 state。不要虚构 imageId、audioId。可复用库：${JSON.stringify(library)}。`,
            ),
      );
      const shotPlan = bundleAt("shot-plan");
      for (const id of shotPlan?.shots.flatMap((s: any) => s.assetIds) || [])
        if (!data.assets.some((a) => a.id === id))
          throw Error(`制作验收：文字分镜需要的资产 ${id} 未提供`);
      saveProgress("assets", data);
      for (const asset of data.assets) {
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
        }
        this.assertCurrent(task, signal);
        if (!asset.imageId) {
          const generationPrompt = assetVisualPrompt(style, asset, data.assets);
          asset.imageId = await media.ensure(
            task.id,
            task.revision,
            "image",
            generationPrompt,
            base?.imageId ? [base.imageId] : [],
            { aspect: p.aspect },
            signal,
          );
          asset.generationPrompt = generationPrompt;
          asset.generationStyleVersion = style.version || style.id;
        }
        saveProgress("assets", data);
      }
      if (
        !data.assets.some((asset) => asset.kind === "character") &&
        !data.voices.length
      )
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
      if (!data.voices.length && voice.provider !== "qwen-tts") {
        const plan = await ask(
          `你是配音 Agent。为以下角色各提供 2 个不同声音的试听候选（不足则 1 个），仅从可用 voice ID ${JSON.stringify(voices.slice(0, 30))} 中选择。返回 JSON {"voices":[{"character":"角色名字","voice":"可用ID","sampleText":"该角色一句适合试听的台词"}]}。角色：${JSON.stringify(data.assets.filter((asset) => asset.kind === "character"))}`,
        );
        data.voices = assetPlanSchema.pick({ voices: true }).parse(plan).voices;
        if (!data.voices.length) throw Error("制作验收：角色声音试听方案为空");
        saveProgress("assets", data);
      }
      const selectedCharacters = new Set<string>();
      data.voices = data.voices.filter((sample) => {
        const saved = approvedVoices.find(
          (v) => v.character === sample.character,
        );
        if (!saved) return true;
        if (selectedCharacters.has(sample.character)) return false;
        selectedCharacters.add(sample.character);
        Object.assign(sample, saved);
        return true;
      });
      if (voice.provider === "qwen-tts") {
        const plan = storyboardSchema.parse(bundleAt("shot-plan"));
        const design = voice.model.includes("VoiceDesign");
        data.voices = await fillMissingVoiceCards(
          castQwenVoices(
            data,
            plan.shots,
            undefined,
            design,
            approvedVoices,
            borrowedVoices,
          ),
          data.assets,
          plan.shots,
          storyBible(upstream),
          ask,
        );
        saveProgress("assets", data);
        const missing = data.voices.filter((v) => v.status === "needs_voice");
        if (missing.length)
          throw Error(
            `制作验收：角色声音待选型：${missing.map((v) => v.character + "：" + v.castingNote).join("；")}`,
          );
      }
      for (const sample of data.voices) {
        if (sample.status === "not_required") continue;
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
    const speechOptions = (shot: Storyboard["shots"][number]) => {
      const selected = assets.voices.find(
        (v) => v.character === shot.speaker && v.status === "ready",
      );
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
            `${style.prompt}。严格依据参考资产保持人物外观。${shot.imagePrompt || shot.prompt}。${shot.camera}。起始状态：${shot.startState}`,
            refs,
            { aspect: p.aspect },
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
              `${style.prompt}。${shot.imagePrompt || shot.prompt}。${shot.camera}。${shot.startState}。局部修订：${imageFeedback}`,
              refs,
              { aspect: p.aspect },
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
        const prompt = `${style.prompt}。${shot.motionPrompt || shot.prompt}。${shot.camera}。起始状态：${shot.startState}；结束状态：${shot.endState}。${shot.route === "native" ? `角色 ${shot.speaker} 用 ${shot.voice} 声音准确说出：${shot.dialogue}` : "保持画面连续，禁止字幕和无关文字。"} ${withAudio ? videoAudioPrompt(shot) : ""} ${feedback}`;
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
                aspect: p.aspect,
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
              aspect: p.aspect,
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

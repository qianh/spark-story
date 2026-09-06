import type { Runtime } from "./runtime";
import { parseResult } from "./connectors";
import {
  productionPrompt,
  timingManifest,
  validateShotTiming,
} from "../../packages/production";
import {
  reviewSchema,
  templates,
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
      style = templates.find((t) => t.id === p.template)!;
    const rules = store.productionRules(p.id);
    const episode = upstream
      .map((a) =>
        store.task(a.taskId).stage === 2
          ? timingManifest(a.content)?.episodes[0]
          : undefined,
      )
      .find(Boolean);
    const context = `画幅 ${p.aspect}，风格 ${style.prompt}。${productionPrompt(rules, task.stage)}\n资产必须分开记录 identity（不变外貌）与 state（服装、年龄、伤势、能力阶段）。分镜必须额外提供 beatId（剧本时间清单中的节拍 ID）、sceneId、imagePrompt（静态构图，不含连续动作）、motionPrompt（单一明确动作、运动方向与结果）、camera（景别、机位、轴线、视线）、startState、endState。prompt 保留镜头摘要。每镜头有叙事用途，所有镜头按节拍连续排列，同一节拍镜头时长之和严格等于节拍时长。动作需分清原因、执行和反应；保持跨镜头人物位置、视线、服饰伤势一致。strategy 仅支持 single（单段）或 tail-chain（超过供应商时限时以前段实际末帧接续），不要虚构其他供应商能力。用户要求：${feedback}。已确认上游：${JSON.stringify(upstream.map((a) => a.content))}`;
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
      const voice = media.connection("speech");
      let voices = Array.isArray(voice.settings?.voices)
        ? (voice.settings!.voices as string[])
        : [String(voice.settings?.voice || "alloy"), "nova", "onyx"];
      if (voice.provider === "elevenlabs") {
        const data = (await (
          await media.request(voice, "/voices", signal)
        ).json()) as any;
        voices = (data.voices || []).map((v: any) => v.voice_id);
        if (!voices.length) throw Error("语音供应商未返回可用声音");
      }
      const data: AssetPlan = assetPlanSchema.parse(
        edited?.type === "assets"
          ? edited.data
          : await ask(
              `你是角色与资产 Agent。提取第一集实际需要的角色、场景、道具，生成定妆提示词；角色图是单角色，不把多人拼在同一图。为每个角色提供 2 个不同声音的试听候选（不足则 1 个），从可用 voice ID ${JSON.stringify(voices.slice(0, 30))} 选择。返回 JSON：{"summary":"说明","assets":[{"id":"稳定ID","name":"名字","kind":"character或scene或prop","prompt":"完整图像生成要求"}],"voices":[{"character":"角色名字","voice":"可用ID","sampleText":"该角色一句适合试听的台词"}]}。不要虚构 imageId、audioId。`,
            ),
      );
      for (const asset of data.assets) {
        this.assertCurrent(task, signal);
        if (!asset.imageId)
          asset.imageId = await media.ensure(
            task.id,
            task.revision,
            "image",
            `${style.prompt}。${asset.prompt}。固定身份：${asset.identity}。当前状态：${asset.state}`,
            [],
            { aspect: p.aspect },
            signal,
          );
        saveProgress("assets", data);
      }
      for (const sample of data.voices) {
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
            { voice: sample.voice },
            signal,
          );
        saveProgress("assets", data);
      }
      return { type: "assets", data };
    }
    const assets = assetPlanSchema.parse(bundleAt("assets"));
    if (task.stage === 4) {
      media.connection("image");
      media.connection("speech");
      const data: Storyboard = storyboardSchema.parse(
        edited?.type === "storyboard"
          ? edited.data
          : await ask(
              `你是分镜 Agent。把第一集完整拆为镜头，不限制总镜头数。每个镜头有明确画面和动作、时长、资产引用。出镜说话标 route=lipsync；旁白/画外音标 separate；原生音画仅在项目要求时标 native。每镜头最多一位出镜发言者，轮流对白拆镜头。声音使用上游 voices 中角色的首个候选（用户可排序选择）。返回 JSON {"summary":"说明","shots":[{"id":"稳定镜头ID","title":"镜头名","prompt":"完整画面动作、景别与运镜","duration":6,"assetIds":["上游asset.id"],"dialogue":"台词或空字符串","speaker":"角色名","voice":"声音ID","route":"separate或lipsync或native"}]}。不要编造素材文件 ID。`,
            ),
      );
      checkShots(data.shots);
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
            { voice: shot.voice },
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
      const video = media.connection("video");
      for (const shot of data.shots) {
        this.assertCurrent(task, signal);
        if (shot.draftImage) {
          delete shot.imageId;
          delete shot.videoId;
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
            { voice: shot.voice || "alloy" },
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
        const max = Number(
          video.settings?.maxDuration || (video.provider === "xai" ? 15 : 12),
        );
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
                { voice: shot.voice || "alloy" },
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
        const prompt = `${style.prompt}。${shot.motionPrompt || shot.prompt}。${shot.camera}。起始状态：${shot.startState}；结束状态：${shot.endState}。${shot.route === "native" ? `角色 ${shot.speaker} 用 ${shot.voice} 声音准确说出：${shot.dialogue}` : "保持画面连续，禁止字幕和无关文字。"} ${feedback}`;
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
              { aspect: p.aspect, duration },
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
            { aspect: p.aspect, duration: shot.duration },
            signal,
          );
        if (shot.route === "lipsync" && shot.audioId)
          shot.videoId = await media.ensure(
            task.id,
            task.revision,
            "lipsync",
            shot.dialogue,
            [shot.videoId, shot.audioId],
            { voice: shot.voice },
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
              `你是后期音乐音效 Agent。根据本集内容给出纯音乐与适量氛围音效生成要求。只返回 JSON {"summary":"剪辑说明","musicPrompt":"配乐提示词","soundPrompt":"背景氛围音效提示词","musicVolume":0.18,"soundVolume":0.25,"subtitles":true,"subtitleSize":32}。不要重写镜头数据。`,
            )) as Record<string, unknown>),
          },
    );
    checkShots(data.shots);
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

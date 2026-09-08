import { supportsVideoAudio } from "./video-audio";
import type { Connection } from "./domain";
import type { MediaKind } from "./media";

// Limits belong to the actual transport/model, not the text model that writes the prompt.
// Sources: xai-org/grok-build image_gen, image_edit, video_gen; xAI Imagine REST;
// OpenAI image/video API guides; Google Gemini native image generation guide.
// https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-tools/src/implementations/grok_build
// https://docs.x.ai/developers/model-capabilities/images/multi-image-editing
// https://docs.x.ai/developers/model-capabilities/video/generation
// https://developers.openai.com/api/reference/typescript/resources/videos/methods/create
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation
// Verified 2026-09-06. Generic protocol limits are adapter limits, not guarantees for unknown models.
export function mediaProfile(c: Connection, kind: MediaKind) {
  const grok = c.transport === "cli" && c.provider === "grok-build";
  const openaiVideo =
    c.transport === "api" && ["openai", "compatible"].includes(c.provider);
  return {
    id: grok ? "grok-build-imagine" : `${c.provider}:${c.model || "default"}`,
    supported:
      c.transport === "cli" ? grok && ["image", "video"].includes(kind) : true,
    maxReferences:
      kind === "video"
        ? 1
        : grok || c.provider === "xai"
          ? 5
          : c.provider === "openai"
            ? 16
            : 14,
    maxDuration: grok
      ? 10
      : openaiVideo
        ? 12
        : c.provider === "xai"
          ? Math.min(15, Number(c.settings?.maxDuration ?? 15))
          : Number(c.settings?.maxDuration ?? 12),
    durations: grok ? [6, 10] : openaiVideo ? [4, 8, 12] : [],
    guidance:
      kind === "image"
        ? "生成单幅静态画面。明确主体、身份与服饰状态、构图、光线及风格；动作只表现一个瞬间。参考图按编号对应，保留指定身份，明确要改的内容与保持不变的内容，不复制拼贴布局。"
        : "生成一个连续镜头。明确主体动作、运动方向、摄像机运动、速度与结束状态；以参考图为首帧，保持身份、服饰、光照与空间关系。不要增加无关切镜或额外事件；音频要求与视觉动作分别描述。",
    channelGuidance:
      c.provider === "gemini"
        ? "明确要求输出图片，用连贯场景描述而不是关键词堆砌；说明每张参考图的用途，指定文字时保留原文。"
        : c.provider === "openai"
          ? "将场景、构图/机位、光照、动作及必须保留的细节分开表述。精确尺寸和时长由请求参数决定，不能靠提示词覆盖不支持的参数。"
          : grok || c.provider === "xai"
            ? "静态参考与运动要求分开；图生视频重点描述动作与镜头变化。不要擅自改写台词、年龄或人物身份。"
            : "使用当前连接实际声明的能力。兼容协议与自定义网关不代表具备某家模型的全部参数；不注入未知模型专用控制词。",
  };
}
export function prepareVisualRequest(
  c: Connection,
  kind: MediaKind,
  prompt: string,
  references: number,
  options: Record<string, any>,
) {
  if (!["image", "video"].includes(kind)) return { prompt, options };
  const profile = mediaProfile(c, kind);
  if (!profile.supported)
    throw Error("此 CLI 尚未接入媒体生成；Grok Build 支持图片和视频");
  if (references > profile.maxReferences)
    throw Error(
      `此渠道 ${kind} 最多支持 ${profile.maxReferences} 张参考图，请先合成已确认关键帧`,
    );
  const o = { ...options };
  if (
    kind === "video" &&
    supportsVideoAudio(c) &&
    o.generateAudio === undefined
  )
    o.generateAudio = true;
  if (kind === "video") {
    if (
      !Number.isFinite(profile.maxDuration) ||
      profile.maxDuration <= 0 ||
      profile.maxDuration > 600
    )
      throw Error("maxDuration 必须是 1～600 内的有效秒数");
    const requested = Number(o.duration ?? o.seconds ?? 6);
    if (
      !Number.isFinite(requested) ||
      requested <= 0 ||
      requested > profile.maxDuration
    )
      throw Error(
        `此渠道单段视频时长必须在 0～${profile.maxDuration} 秒内，请拆段生成`,
      );
    o.duration =
      profile.durations.find((n) => n >= requested) || Math.ceil(requested);
    if (
      profile.durations.length &&
      o.seconds !== undefined &&
      Number(o.seconds) !== o.duration
    )
      throw Error("seconds 与渠道支持的生成时长不一致");
    if (profile.durations.length) o.seconds = o.duration;
    o.requestedDuration = requested;
    if (
      c.transport === "cli" &&
      o.resolution &&
      !["480p", "720p"].includes(o.resolution)
    )
      throw Error("Grok Build 图生视频支持 480p 或 720p");
  }
  const aspect = o.aspect || "9:16";
  if (
    !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspect) ||
    aspect.split(":").some((n: string) => Number(n) <= 0)
  )
    throw Error("画幅比例无效");
  if (
    (c.provider === "xai" || c.transport === "cli") &&
    ![
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "2:1",
      "1:2",
      "19.5:9",
      "9:19.5",
      "20:9",
      "9:20",
    ].includes(aspect)
  )
    throw Error("此渠道不支持该画幅，请选择标准画幅");
  if (c.transport === "api" && c.provider === "openai" && kind === "video") {
    if (!/^sora-2(?:-pro)?$/.test(c.model))
      throw Error(
        "OpenAI 视频接口需要 sora-2 或 sora-2-pro；其他模型请使用对应协议",
      );
    if (!["9:16", "16:9"].includes(aspect))
      throw Error("当前 Sora 适配器支持 9:16 或 16:9");
    if (
      o.size &&
      !["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(o.size)
    )
      throw Error("Sora 视频尺寸无效");
  }
  if (
    kind === "image" &&
    c.provider === "openai" &&
    /^gpt-image/.test(c.model) &&
    o.quality &&
    !["auto", "low", "medium", "high"].includes(o.quality)
  )
    throw Error("GPT Image quality 仅支持 auto/low/medium/high");
  if (
    c.provider === "gemini" &&
    o.imageSize &&
    (!/^gemini-3/.test(c.model) || !["1K", "2K", "4K"].includes(o.imageSize))
  )
    throw Error(
      "imageSize 需要支持该参数的 Gemini 3 图像模型，取值为 1K/2K/4K",
    );
  if (c.provider === "gemini" && /^(imagen|veo)/.test(c.model))
    throw Error(
      "当前 Gemini 原生图像接口需要 Gemini 图像模型；Imagen/Veo 使用不同接口，不能混用",
    );
  if (c.provider === "xai" && kind === "video") {
    if (!["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].includes(aspect))
      throw Error("xAI 视频画幅不受支持");
    if (o.resolution && !["480p", "720p", "1080p"].includes(o.resolution))
      throw Error("xAI 视频分辨率无效");
    if (o.resolution === "1080p" && c.model !== "grok-imagine-video-1.5")
      throw Error("1080p 需要 grok-imagine-video-1.5");
  }
  // A finished text-to-image prompt must not be turned into another writing assignment.
  if (c.provider === "grok-build" && c.transport === "cli" && kind === "image" && !references) {
    return {
      prompt: `${prompt}${typeof o.promptGuidance === "string" && o.promptGuidance.trim() ? `\n${o.promptGuidance.trim()}` : ""}`,
      options: { ...o, originalPrompt: prompt, promptProfile: profile.id },
    };
  }
  const compiled = `${profile.guidance}\n${kind === "video" && o.generateAudio === true ? "同步声音：依据场景与用户要求判断是否需要环境音效、动作音效或背景音乐，需要时与视频一并生成；无需时保持安静。配乐不盖过对白，不擅自增加人声。" : ""}\n${profile.channelGuidance}\n画幅：${aspect}。${kind === "video" ? `生成时长：${o.duration} 秒；剪辑目标：${o.requestedDuration} 秒。动作需在剪辑目标内完成，剩余时间保持结束状态。` : ""}\n${references ? `参考图共 ${references} 张，按传入顺序编号 1～${references}。` : ""}\n创作要求（事实与台词保持不变）：\n${prompt}${typeof o.promptGuidance === "string" && o.promptGuidance.trim() ? `\n本连接补充要求：${o.promptGuidance}` : ""}`;
  return {
    prompt: compiled,
    options: { ...o, originalPrompt: prompt, promptProfile: profile.id },
  };
}

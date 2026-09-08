import type { Connection } from "./domain";
export function supportsVideoAudio(c: Connection) {
  return (
    (c.transport === "cli" && c.provider === "grok-build") ||
    (c.transport === "api" &&
      (c.provider === "xai" ||
        (c.provider === "openai" && /^sora-2/.test(c.model)))) ||
    c.settings?.nativeAudio === true
  );
}
export function videoAudioPrompt(shot: {
  soundPrompt?: string;
  musicPrompt?: string;
  route?: string;
  dialogue?: string;
}) {
  return `同步音频要求：\n环境与动作音效：${shot.soundPrompt || "根据场景判断是否需要环境声和动作音效；需要时生成与画面同步的风雨、脚步、衣料或物体接触声，保持空间远近关系；安静场景允许留白，不添加无关声音"}。\n背景音乐：${shot.musicPrompt || "根据本镜头情绪判断是否需要配乐；需要时生成低音量、无歌词的器乐，不抢对白；无需配乐时不要添加"}。\n${shot.route === "native" && shot.dialogue ? "对白按指定原文生成，音效和音乐不得盖过对白。" : "角色对白由独立配音提供，本视频禁止生成说话、旁白、歌声或含糊人声，只生成所需音效与配乐。"}\n声音与动作时刻同步，不在段尾突然截断；连续镜头分段时维持相同氛围、乐器和节奏，不重新起奏。`;
}

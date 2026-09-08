import { test, expect } from "bun:test";
import { videoAudioPrompt, supportsVideoAudio } from "../packages/video-audio";
import { prepareVisualRequest } from "../packages/media-profiles";
import type { Connection } from "../packages/domain";
test("视频提示明确同步音效音乐，尊重无音乐与独立配音，按渠道开启音频", () => {
  const prompt = videoAudioPrompt({
    soundPrompt: "雨声与脚步同步",
    musicPrompt: "无",
    route: "separate",
  });
  expect(prompt).toContain("雨声与脚步同步");
  expect(prompt).toContain("背景音乐：无");
  expect(prompt).toContain("禁止生成说话");
  const c = {
    transport: "api",
    provider: "xai",
    model: "grok-imagine-video",
  } as Connection;
  expect(
    prepareVisualRequest(c, "video", "散步", 0, {}).options.generateAudio,
  ).toBe(true);
  expect(
    prepareVisualRequest(c, "video", "无声", 0, { generateAudio: false })
      .options.generateAudio,
  ).toBe(false);
  expect(supportsVideoAudio({ ...c, provider: "compatible" })).toBe(false);
});

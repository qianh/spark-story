import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { connectionInput, type Connection } from "../packages/domain";
import { qwenOptions } from "../apps/server/qwen-tts";
import { Store } from "../apps/server/store";
import { MediaService } from "../apps/server/media-service";
const c: Connection = {
  id: "qwen",
  name: "本地配音",
  transport: "cli",
  provider: "qwen-tts",
  executable: resolve("tests/fixtures/qwen-tts.ts"),
  model: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
  keyEnv: "",
  baseUrl: "",
  reserveCents: 0,
  health: "installed",
  version: "test",
};
test("本地 Qwen 连接无需密钥、拒绝错误模型与无效音色", () => {
  expect(connectionInput.safeParse(c).success).toBe(true);
  expect(connectionInput.safeParse({ ...c, model: "Qwen-Base" }).success).toBe(
    false,
  );
  expect(qwenOptions({}).voice).toBe("Vivian");
  expect(qwenOptions({ voice: "serena" }).voice).toBe("Serena");
  expect(() => qwenOptions({ voice: "alloy" })).toThrow("不支持");
});
test("本地配音传递原文与情绪、校验 WAV、零预算复用、转写独立", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-test-"));
  const s = new Store(":memory:");
  try {
    const p = s.createProject({
      name: "配音",
      source: "你好",
      inputType: "idea",
      aspect: "9:16",
      template: "cel",
      budget: 0,
    });
    s.saveConnection(c);
    s.db.run("INSERT INTO bindings VALUES(?,?)", ["语音模型", c.id]);
    const m = new MediaService(s, root);
    const t = s.tasks(p.id).find((t) => t.stage === 3)!;
    const j = m.create(t.id, t.revision, "speech", "你好，先走。", [], {
      instructions: "轻声、焦急",
    });
    const id = await m.run(j.id);
    expect(m.files.get(id).mime).toContain("wav");
    const r = JSON.parse(
      await readFile(
        join(root, "runs", "qwen-tts", j.id, "request.json"),
        "utf8",
      ),
    );
    expect(r.text).toBe("你好，先走。");
    expect(r.args).toContain("Chinese");
    expect(r.args).toContain("轻声、焦急");
    expect(r.args).toContain("--temperature");
    expect(r.args).toContain("0.9");
    expect(r.args).toContain("--top_p");
    expect(r.args).toContain("1.0");
    expect(r.args).toContain("--repetition_penalty");
    expect(r.args).toContain("1.05");
    expect(await m.run(j.id)).toBe(id);
    expect(s.list("SELECT * FROM costs")).toHaveLength(0);
    expect(await m.transcribe(id, new AbortController().signal)).toBe("实际音频转写");
    expect(await m.transcribe(id, new AbortController().signal)).toBe("实际音频转写");
    expect(s.list("SELECT * FROM media_transcripts")).toHaveLength(1);
    expect(s.list("SELECT * FROM costs")).toHaveLength(0);
    s.saveConnection({ ...c, settings: { transcriptionModel: "broken" } });
    await expect(m.transcribe(id, new AbortController().signal)).rejects.toThrow("语音审核待处理");
    expect(m.files.get(id).mime).toContain("wav");
    expect(s.list("SELECT * FROM media_transcripts")).toHaveLength(1);
    await expect(m.transcribe(id, AbortSignal.abort())).rejects.toThrow();
  } finally {
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VoiceDesign 接受描述而非预设音色，缺少描述在调用前拒绝", () => {
  const model = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit";
  expect(connectionInput.safeParse({ ...c, model }).success).toBe(true);
  expect(() => qwenOptions({}, model)).toThrow("人物声线描述");
  const o = qwenOptions(
    { instructions: "体现17岁少年男声，营造出未满20岁清亮国漫少年配音的听觉效果。" },
    model,
  );
  expect(o.voice).toBe("VoiceDesign");
  expect(o.temperature).toBe(0.9);
  expect(o.top_p).toBe(1);
  expect(o.repetition_penalty).toBe(1.05);
});

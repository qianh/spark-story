import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../apps/server/store";
import { MediaService } from "../apps/server/media-service";
import { toolMediaPaths } from "../apps/server/grok-media";
import { prepareVisualRequest, mediaProfile } from "../packages/media-profiles";
import type { Connection } from "../packages/domain";
const cli: Connection = {
  id: "grok",
  name: "grok",
  transport: "cli",
  provider: "grok-build",
  executable: resolve("tests/fixtures/grok-media.ts"),
  model: "",
  baseUrl: "",
  keyEnv: "",
  reserveCents: 0,
  health: "installed",
  version: "test",
};
test("渠道时长与参考图限制、提示词编译不更改台词和事实", () => {
  const input = "幼女始终在怀中；台词：先走。";
  const r = prepareVisualRequest(cli, "video", input, 1, {
    duration: 7,
    aspect: "9:16",
  });
  expect(r.options.duration).toBe(10);
  expect(r.options.requestedDuration).toBe(7);
  expect(r.prompt).toContain(input);
  const compatible = {
    ...cli,
    transport: "api" as const,
    provider: "compatible" as const,
    settings: { maxDuration: 30 },
  };
  expect(
    prepareVisualRequest(compatible, "video", input, 0, { duration: 7 }).options
      .duration,
  ).toBe(8);
  expect(() =>
    prepareVisualRequest(compatible, "video", input, 0, { duration: 20 }),
  ).toThrow("拆段");
  expect(
    mediaProfile({ ...compatible, provider: "xai" }, "video").maxDuration,
  ).toBe(15);
  expect(() =>
    prepareVisualRequest(cli, "video", input, 1, { duration: 11 }),
  ).toThrow("拆段");
  expect(() =>
    prepareVisualRequest(cli, "video", input, 2, { duration: 6 }),
  ).toThrow("参考图");
  expect(() => prepareVisualRequest(cli, "image", input, 6, {})).toThrow(
    "参考图",
  );
  expect(() =>
    prepareVisualRequest({ ...cli, provider: "claude" }, "image", input, 0, {}),
  ).toThrow("尚未接入");
  expect(
    mediaProfile({ ...cli, transport: "api", provider: "gemini" }, "image")
      .channelGuidance,
  ).toContain("连贯场景");
  expect(
    mediaProfile({ ...cli, transport: "api", provider: "compatible" }, "image")
      .channelGuidance,
  ).toContain("未知模型");
});
test("只接受成功工具结果的媒体路径，拒绝文字声称和工具错误", () => {
  const payload = JSON.stringify({ path: "/tmp/file.png" });
  expect(
    toolMediaPaths({
      type: "assistant",
      message: { content: [{ type: "text", text: payload }] },
    }),
  ).toEqual([]);
  expect(
    toolMediaPaths({
      message: {
        content: [{ type: "tool_result", is_error: true, content: payload }],
      },
    }),
  ).toEqual([]);
  expect(
    toolMediaPaths({
      message: { content: [{ type: "tool_result", content: payload }] },
    }),
  ).toEqual(["/tmp/file.png"]);
});
for (const mode of ["success", "after-output-error", "prose-only"])
  test(`Grok CLI 媒体执行 ${mode}：校验、恢复与去重`, async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-media-test-"));
    const s = new Store(":memory:");
    try {
      const p = s.createProject({
        name: "媒体",
        source: "球",
        inputType: "idea",
        aspect: "1:1",
        template: "cel",
        budget: 0,
      });
      s.saveConnection({ ...cli, model: mode });
      s.db.run("INSERT INTO bindings VALUES(?,?)", ["图片模型", cli.id]);
      const m = new MediaService(s, root);
      const t = s.tasks(p.id).find((t) => t.stage === 3)!;
      const job = m.create(t.id, t.revision, "image", "蓝球", [], {
        aspect: "1:1",
      });
      if (mode === "prose-only") {
        await expect(m.run(job.id)).rejects.toThrow("未返回可验证");
        expect(m.job(job.id).status).toBe("unknown");
        await expect(m.run(job.id)).rejects.toThrow("提交结果未知");
      } else {
        if (mode === "after-output-error") {
          await expect(m.run(job.id)).rejects.toThrow();
          expect(m.job(job.id).status).toBe("detached");
        }
        const id = await m.run(job.id);
        expect(m.files.get(id).kind).toBe("image");
        expect(
          m.create(t.id, t.revision, "image", "蓝球", [], { aspect: "1:1" }).id,
        ).toBe(job.id);
        expect(await m.run(job.id)).toBe(id);
      }
      expect(
        await readFile(
          join(root, "runs", "media-cli", job.id, "invoked"),
          "utf8",
        ),
      ).toBe("1");
      expect(s.list("SELECT * FROM costs")).toHaveLength(0);
    } finally {
      s.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

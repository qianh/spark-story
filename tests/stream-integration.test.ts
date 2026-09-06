import { test, expect } from "bun:test";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { generate, probe } from "../apps/server/connectors";
import type { Connection } from "../packages/domain";
const executable = resolve("tests/fixtures/stream-cli.ts");
await chmod(executable, 0o755);
const cli: Connection = {
  id: "fixture-stream",
  name: "测试 CLI",
  transport: "cli",
  provider: "claude",
  executable,
  model: "success",
  baseUrl: "",
  keyEnv: "",
  reserveCents: 0,
  health: "installed",
  version: "",
};
test("CLI 空闲看门狗实际终止进程并返回明确原因", async () => {
  await expect(
    generate(
      { ...cli, model: "abort", settings: { cliIdleTimeoutSeconds: 1 } },
      "test",
      process.cwd(),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("无有效输出");
});
test("累计协议流超过 4 MB 不截断正常正文；真实超限即使退出 0 也拒绝", async () => {
  const run = (model: string) =>
    generate(
      { ...cli, model },
      "test",
      process.cwd(),
      new AbortController().signal,
      () => {},
    );
  expect(await run("large-protocol")).toBe(
    "# 全剧规划\n" + "故事节拍。".repeat(6000),
  );
  await expect(run("oversize-result")).rejects.toThrow("正文超过 4 MB");
  await expect(run("oversize-line")).rejects.toThrow("单条消息超过 8 MB");
});
test("CLI 在进程完成前回传正文且保留换行，完成消息不重复拼接", async () => {
  const text: string[] = [];
  let finished = false;
  const promise = generate(
    cli,
    "test",
    process.cwd(),
    new AbortController().signal,
    () => {},
    [],
    (draft) => {
      expect(finished).toBe(false);
      text.push(draft);
    },
  ).then((v) => {
    finished = true;
    return v;
  });
  expect(await promise).toBe("# 雨中\n\n晴天");
  expect(text[0]).toBe("# 雨中");
  expect(text.join("")).not.toContain("隐藏内容");
  expect((await probe(cli)).health).toBe("installed");
});
test("Grok 使用结构化流；CLI 错误、中断、空响应不误报完成", async () => {
  expect(
    await generate(
      { ...cli, provider: "grok-build" },
      "test",
      process.cwd(),
      new AbortController().signal,
      () => {},
    ),
  ).toContain("晴天");
  for (const [model, message] of [
    ["error-result", "额度不足"],
    ["empty", "未交付"],
    ["exit-error", "fixture failure"],
  ])
    await expect(
      generate(
        { ...cli, model },
        "test",
        process.cwd(),
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(message);
  await expect(
    generate(
      { ...cli, model: "abort" },
      "test",
      process.cwd(),
      AbortSignal.timeout(100),
      () => {},
    ),
  ).rejects.toThrow("中断");
  await expect(
    generate(
      { ...cli, executable: "/not-installed-spark" },
      "test",
      process.cwd(),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow();
});
test("API 请求使用流式协议，并兼容供应商返回一次性 JSON", async () => {
  const keyName = "SPARK_STREAM_TEST_KEY";
  process.env[keyName] = "fixture-key";
  let mode = "stream";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as any;
      expect(body.stream).toBe(true);
      if (mode === "http-error") return new Response("failed", { status: 429 });
      if (mode === "json")
        return Response.json({
          choices: [{ message: { content: "一次性结果" } }],
        });
      if (mode === "empty") return Response.json({});
      if (new URL(req.url).pathname === "/messages") {
        expect(req.headers.get("x-api-key")).toBe("fixture-key");
        return new Response(
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"中文"}}\n\ndata: {"type":"message_stop"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      expect(req.headers.get("authorization")).toBe("Bearer fixture-key");
      return new Response(
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const c: Connection = {
    ...cli,
    id: "api-test-stream",
    transport: "api",
    provider: "compatible",
    keyEnv: keyName,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
  const run = (connection = c) =>
    generate(
      connection,
      "test",
      process.cwd(),
      new AbortController().signal,
      () => {},
      [],
      (v) => expect(v.length).toBeGreaterThan(0),
    );
  try {
    expect(await run()).toBe("你好");
    expect(await run({ ...c, provider: "anthropic" })).toBe("中文");
    mode = "json";
    expect(await run()).toBe("一次性结果");
    mode = "empty";
    await expect(run()).rejects.toThrow("未返回");
    mode = "http-error";
    await expect(run()).rejects.toThrow("429");
  } finally {
    server.stop(true);
    delete process.env[keyName];
  }
});

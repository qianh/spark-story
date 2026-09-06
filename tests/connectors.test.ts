import { expect, test } from "bun:test";
import {
  decodeCliEvent,
  parseResult,
  readTextStream,
} from "../apps/server/connectors";
test("SSE 跨 UTF-8 分块增量渲染，支持两种文本协议", async () => {
  const body =
    'data: {"choices":[{"delta":{"content":"雨"}}]}\r\n\r\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"不展示"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"晴"}}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(body),
    chunks: string[] = [];
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    }),
  );
  expect(await readTextStream(response, (text) => chunks.push(text))).toBe(
    "雨晴",
  );
  expect(chunks).toEqual(["雨", "雨晴"]);
});
test("SSE 断流或错误不发布成功产物", async () => {
  await expect(
    readTextStream(
      new Response('data: {"choices":[{"delta":{"content":"半篇"}}]}\n\n'),
      () => {},
    ),
  ).rejects.toThrow("意外结束");
  await expect(
    readTextStream(
      new Response('data: {"type":"error","error":{"message":"失败"}}\n\n'),
      () => {},
    ),
  ).rejects.toThrow("执行失败");
  await expect(
    readTextStream(new Response("data: [DONE]\n\n"), () => {}),
  ).rejects.toThrow("未返回");
  expect(
    await readTextStream(
      new Response(
        'data: {"type":"content_block_start","content_block":{"type":"text","text":"正文"}}\n\ndata: {"type":"message_stop"}',
      ),
      () => {},
    ),
  ).toBe("正文");
});
test("流式事件只提取正文，不展示思考与工具参数", () => {
  expect(
    decodeCliEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "雨中的少女" },
      },
    }).delta,
  ).toBe("雨中的少女");
  expect(
    decodeCliEvent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "继续" },
    }).delta,
  ).toBe("继续");
  expect(
    decodeCliEvent({ msg: { type: "agent_message_delta", delta: "正文" } })
      .delta,
  ).toBe("正文");
  expect(
    decodeCliEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "私有思考" },
      },
    }).delta,
  ).toBeUndefined();
  expect(
    decodeCliEvent({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "工具输入" },
    }).delta,
  ).toBeUndefined();
});
test("解析旧版 Codex 成功与版本不兼容错误", () => {
  expect(
    decodeCliEvent({
      id: "0",
      msg: { type: "agent_message", message: "故事产物" },
    }).text,
  ).toBe("故事产物");
  expect(
    decodeCliEvent({
      id: "0",
      msg: { type: "error", message: "model requires a newer version" },
    }).error,
  ).toContain("newer version");
});
test("解析 Codex 新事件与 Claude 结果，不依赖终端 UI", () => {
  expect(
    decodeCliEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "稿件" },
    }).text,
  ).toBe("稿件");
  expect(decodeCliEvent({ type: "result", result: "审核完成" }).text).toBe(
    "审核完成",
  );
  expect(
    decodeCliEvent({ type: "result", is_error: true, result: "额度不足" })
      .error,
  ).toBe("额度不足");
});
test("结构化交付支持代码围栏，不能把非 JSON 标记为通过", () => {
  expect(parseResult('```json\n{"pass":true,"feedback":"通过"}\n```')).toEqual({
    pass: true,
    feedback: "通过",
  });
  expect(() => parseResult("应该通过吧")).toThrow();
});

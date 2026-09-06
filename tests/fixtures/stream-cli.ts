#!/usr/bin/env bun
export {};
import { timingFixture, inventoryFixture } from "./timing";
import { seriesResponse } from "./series";
if (process.argv.includes("--version")) {
  console.log("fixture 1.0");
  process.exit(0);
}
const args = process.argv.slice(2),
  mode = args[args.indexOf("--model") + 1];
const prompt = await Bun.stdin.text();
if (mode === "large-protocol") {
  const result = "# 全剧规划\n" + "故事节拍。".repeat(6000);
  for (let i = 0; i < 70; i++)
    await Bun.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: result }] },
      }) + "\n",
    );
  console.log(JSON.stringify({ type: "result", result }));
  process.exit(0);
}
if (mode === "oversize-result" || mode === "oversize-line") {
  process.on("SIGINT", () => process.exit(0));
  if (mode === "oversize-result")
    await Bun.stdout.write(
      JSON.stringify({
        type: "result",
        result: "x".repeat(4 * 1024 * 1024 + 1),
      }) + "\n",
    );
  else await Bun.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
  process.exit(0);
}
if (mode === "episode-flow") {
  console.log(
    JSON.stringify({ type: "result", result: seriesResponse(prompt) }),
  );
  process.exit(0);
}
if (mode === "exit-error") {
  console.error("fixture failure");
  process.exit(2);
}
if (mode === "empty") {
  console.log("startup log");
  process.exit(0);
}
if (mode === "error-result") {
  console.log(
    JSON.stringify({ type: "result", is_error: true, result: "额度不足" }),
  );
  process.exit(0);
}
if (
  args.includes("stream-json") &&
  !args.includes("--include-partial-messages")
)
  throw Error("missing partial flag");
console.log(JSON.stringify({ type: "system", subtype: "init" }));
console.log(
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "隐藏内容" },
    },
  }),
);
const event =
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "# 雨中" },
    },
  }) + "\n";
const bytes = Buffer.from(event),
  index = bytes.indexOf(Buffer.from("雨")) + 1;
await Bun.stdout.write(bytes.subarray(0, index));
await Bun.sleep(10);
await Bun.stdout.write(bytes.subarray(index));
await Bun.sleep(mode === "abort" ? 5000 : 80);
console.log(
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "\n\n晴天" },
    },
  }),
);
console.log(
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "# 雨中\n\n晴天" }] },
  }),
);
console.log(JSON.stringify({ type: "result", result: "# 雨中\n\n晴天" }));

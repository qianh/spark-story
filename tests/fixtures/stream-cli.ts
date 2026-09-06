#!/usr/bin/env bun
export {};
import { timingFixture, inventoryFixture } from "./timing";
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
  if (prompt.startsWith("你是剧情展开 Agent")) {
    console.log(
      JSON.stringify({
        type: "result",
        result: JSON.stringify(inventoryFixture(2)),
      }),
    );
    process.exit(0);
  }
  let result = prompt.startsWith("你是主控")
    ? '{"pass":true,"feedback":"规划完整且符合上游"}'
    : prompt.includes("只验收第一集")
      ? "# 全剧分集规划\n\n共 2 集，按相遇与揭晓两段因果拆分。\n\n## EP001 雨中相遇\n事件：少女遇见信使。冲突：是否相信来信。人物变化：从怀疑到行动。结尾悬念：信中日期来自明天。下一集承接：追问信使来历。\n\n## EP002 真相揭晓\n承接信使线索，揭示来信真相，人物作出选择并完成收束。"
      : prompt.includes("严格依据已确认分集规划")
        ? "# 第一集剧本\n\n## 场景 S001 雨中相遇\n少女撑伞，信使递出一封来信。\n\n对白 D001：这封信为什么写着明天？\n\n结尾：停在来信日期，承接第二集。"
        : "# 故事概要\n\n少女在雨中收到来自明天的信，她寻找信使并揭晓真相。";
  if (!prompt.startsWith("你是主控") && result.startsWith("# 全剧"))
    result += timingFixture(90, 2);
  if (!prompt.startsWith("你是主控") && result.startsWith("# 第一集"))
    result += timingFixture();
  console.log(JSON.stringify({ type: "result", result }));
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

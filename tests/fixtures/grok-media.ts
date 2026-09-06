#!/usr/bin/env bun
import sharp from "sharp";
import { join } from "node:path";
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args.includes("--version")) {
  console.log("grok fixture");
  process.exit(0);
}
const mode = args[args.indexOf("--model") + 1];
const tools = args[args.indexOf("--tools") + 1];
if (!tools || !args.includes("--no-subagents"))
  throw Error("missing media restrictions");
await Bun.write(
  join(cwd, "invoked"),
  String(
    Number(
      await Bun.file(join(cwd, "invoked"))
        .text()
        .catch(() => "0"),
    ) + 1,
  ),
);
const path = join(cwd, "generated.png");
await sharp({
  create: { width: 64, height: 64, channels: 3, background: "blue" },
})
  .png()
  .toFile(path);
if (mode !== "prose-only")
  console.log(
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call1",
            content: JSON.stringify({
              path,
              filename: "generated.png",
              session_folder: "images",
            }),
          },
        ],
      },
    }),
  );
if (mode === "after-output-error") process.exit(1);
console.log(
  JSON.stringify({ type: "result", result: JSON.stringify({ path }) }),
);

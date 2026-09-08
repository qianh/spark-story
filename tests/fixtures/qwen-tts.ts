#!/usr/bin/env bun
import { join } from "node:path";
const args = process.argv;
if (args.includes("-c")) {
  if (args.at(-1) === "broken") process.exit(1);
  console.log('SPARK_TRANSCRIPT={"text":"实际音频转写"}');
  process.exit(0);
}
const cwd = args[args.indexOf("--output_path") + 1];
const text = await Bun.stdin.text();
await Bun.write(join(cwd, "request.json"), JSON.stringify({ args, text }));
const wav = Buffer.alloc(44 + 4800);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24);
wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(4800, 40);
await Bun.write(join(cwd, "speech.wav"), wav);

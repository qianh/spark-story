import { mkdir, readFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Connection } from "../../packages/domain";
import type { MediaJob } from "../../packages/media";
export const qwenVoices = [
  "Vivian",
  "Serena",
  "Uncle_Fu",
  "Dylan",
  "Eric",
  "Ryan",
  "Aiden",
  "Ono_Anna",
  "Sohee",
];
export const qwenReady = (root: string, id: string) =>
  resolve(root, "runs", "qwen-tts", id, "ready");
export function qwenOptions(options: Record<string, any>, model = "") {
  const design = model.includes("VoiceDesign");
  if (
    design &&
    (typeof options.instructions !== "string" || !options.instructions.trim())
  )
    throw Error("VoiceDesign 必须填写人物声线描述 instructions");
  const voice = design
    ? "VoiceDesign"
    : qwenVoices.find(
        (v) =>
          v.toLowerCase() === String(options.voice || "Vivian").toLowerCase(),
      );
  if (!voice)
    throw Error(
      `Qwen CustomVoice 不支持该音色，可选：${qwenVoices.join("、")}`,
    );
  const language = String(options.language || "Chinese");
  if (
    ![
      "Chinese",
      "English",
      "Japanese",
      "Korean",
      "German",
      "French",
      "Russian",
      "Portuguese",
      "Spanish",
      "Italian",
      "Auto",
    ].includes(language)
  )
    throw Error("Qwen 配音语言无效，请使用 Chinese、English 等完整语言名");
  return { voice, language, instructions: String(options.instructions || "") };
}
let queue: Promise<void> = Promise.resolve();
export async function runQwenTts(
  c: Connection,
  job: MediaJob,
  root: string,
  signal: AbortSignal,
  event: (message: string) => void,
) {
  const previous = queue;
  let release!: () => void;
  const slot = new Promise<void>((r) => {
    release = r;
  });
  queue = previous.then(() => slot);
  event("本地配音等待执行；同一时间仅加载一个 Qwen 生成任务");
  let abortWait = () => {};
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        abortWait = () => reject(signal.reason || Error("任务已中断"));
        signal.addEventListener("abort", abortWait, { once: true });
        if (signal.aborted) abortWait();
      }),
    ]);
    signal.removeEventListener("abort", abortWait);
    signal.throwIfAborted();
    const cwd = resolve(root, "runs", "qwen-tts", job.id);
    const output = resolve(cwd, "speech.wav");
    await mkdir(cwd, { recursive: true });
    if (!existsSync(qwenReady(root, job.id))) {
      const o = qwenOptions(JSON.parse(job.options), c.model);
      const args = [
        c.executable,
        "-u",
        "-m",
        "mlx_audio.tts.generate",
        "--model",
        c.model,
        ...(c.model.includes("VoiceDesign") ? [] : ["--voice", o.voice]),
        "--lang_code",
        o.language,
        "--output_path",
        cwd,
        "--file_prefix",
        "speech",
        "--join_audio",
        "--audio_format",
        "wav",
        "--verbose",
      ];
      if (o.instructions) args.push("--instruct", o.instructions);
      event(`Qwen 正在加载模型并生成 ${o.voice} 配音；首次加载可能较慢`);
      const child = Bun.spawn(args, {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(job.prompt);
      child.stdin.end();
      let timedOut = false;
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const timer = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        30 * 60 * 1000,
      );
      let tail = "";
      const consume = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            tail = (tail + decoder.decode(value, { stream: true })).slice(
              -4000,
            );
          }
        } finally {
          reader.releaseLock();
        }
      };
      const heartbeat = setInterval(
        () =>
          event(
            "Qwen 本地推理仍在执行，尚未返回完整音频；这不是生成完成百分比",
          ),
        15000,
      );
      try {
        const [code] = await Promise.all([
          child.exited,
          consume(child.stdout),
          consume(child.stderr),
        ]);
        signal.throwIfAborted();
        if (timedOut) throw Error("Qwen 本地配音超过 30 分钟，已终止进程");
        if (code !== 0) throw Error(`Qwen 配音失败：${tail}`);
        const info = await lstat(output);
        if (!info.isFile() || info.size <= 44 || info.size > 200 * 1024 * 1024)
          throw Error("Qwen 未返回有效 WAV 文件");
        await Bun.write(qwenReady(root, job.id), "complete");
      } finally {
        clearTimeout(timer);
        clearInterval(heartbeat);
        signal.removeEventListener("abort", stop);
      }
    }
    const cached = await lstat(output);
    if (
      !cached.isFile() ||
      cached.isSymbolicLink() ||
      cached.size > 200 * 1024 * 1024
    )
      throw Error("本地配音缓存文件无效");
    signal.throwIfAborted();
    event("本地配音已返回，正在检查音频并保存试听");
    return { bytes: await readFile(output), mime: "audio/wav" };
  } finally {
    signal.removeEventListener("abort", abortWait);
    release();
  }
}

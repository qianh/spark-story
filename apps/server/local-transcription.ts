import type { Connection } from "../../packages/domain";
import { command } from "./media-files";

export function localTranscriptionOptions(c: Connection) {
  return {
    executable: String(c.settings?.transcriptionExecutable || c.executable),
    model: String(c.settings?.transcriptionModel || "mlx-community/whisper-large-v3-turbo"),
  };
}

export async function transcribeLocal(c: Connection, path: string, signal: AbortSignal) {
  const { executable, model } = localTranscriptionOptions(c);
  // Never provide the expected dialogue as a prompt: review must hear the actual file.
  const script = `import json, sys
import mlx_whisper
result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2], verbose=None, condition_on_previous_text=False)
print("SPARK_TRANSCRIPT=" + json.dumps({"text": result["text"]}, ensure_ascii=False))`;
  try {
    const out = await command(executable, ["-u", "-c", script, path, model], signal);
    const line = out.split("\n").reverse().find((s) => s.startsWith("SPARK_TRANSCRIPT="));
    const result = JSON.parse(line?.slice("SPARK_TRANSCRIPT=".length) || "null");
    if (typeof result?.text !== "string") throw Error("转写未返回有效文本");
    return result.text.trim() as string;
  } catch (error) {
    signal.throwIfAborted();
    throw Error(`语音审核待处理：配音已保存，本地 Whisper 转写失败。请检查转写 Python 环境的 mlx-whisper 和模型，或配置 transcriptionConnectionId 使用转写 API。${error instanceof Error ? error.message : error}`);
  }
}

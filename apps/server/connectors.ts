import { spawn } from "node:child_process";
import { CliActivityGuard } from "./cli-guard";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { Connection } from "../../packages/domain";
import { getCredential } from "./credentials";
import sharp from "sharp";
import { StringDecoder } from "node:string_decoder";

export async function probe(c: Connection) {
  if (c.transport === "api")
    return {
      health: getCredential(c) ? "key_present" : "key_missing",
      version: "仅检查环境变量；未发起付费请求",
    };
  await access(c.executable, constants.X_OK);
  const child = Bun.spawn([c.executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [output, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw Error("工具版本探测失败");
    return {
      health: c.provider === "grokcli" ? "unverified" : "installed",
      version: output.trim().slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}
export function parseResult(raw: string): unknown {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{"),
      end = clean.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(clean.slice(start, end + 1));
    throw Error("模型没有返回有效结构化结果");
  }
}
export function decodeCliEvent(e: any): {
  text?: string;
  error?: string;
  type?: string;
  delta?: string;
} {
  const event = e.msg || e;
  let text: string | undefined;
  if (event.type === "agent_message") text = event.message;
  if (event.type === "item.completed" && event.item?.type === "agent_message")
    text = event.item.text;
  if (event.type === "assistant" && event.message?.content)
    text = event.message.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
  if (typeof event.result === "string") text = event.result;
  if (typeof event.response === "string") text = event.response;
  const error =
    event.type === "error" || event.is_error
      ? String(
          event.message ||
            event.error?.message ||
            event.error ||
            event.result ||
            "CLI 执行失败",
        )
      : undefined;
  const stream = event.type === "stream_event" ? event.event : event;
  const delta =
    stream?.type === "content_block_delta" &&
    stream.delta?.type === "text_delta"
      ? stream.delta.text
      : event.type === "agent_message_delta"
        ? event.delta
        : undefined;
  return {
    text,
    error,
    type: event.type,
    delta: typeof delta === "string" ? delta : undefined,
  };
}

export async function generate(
  c: Connection,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  onEvent: (message: string) => void,
  images: string[] = [],
  onText: (text: string) => void = () => {},
): Promise<string> {
  if (c.transport === "api")
    return generateApi(c, prompt, signal, images, onText);
  if (c.provider === "grokcli")
    throw Error("grokcli 的非交互协议尚未验证；请使用已适配的 CLI");
  const args =
    c.provider === "codex"
      ? [
          "exec",
          "--json",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "-c",
          "mcp_servers={}",
          "-",
        ]
      : c.provider === "claude"
        ? [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
          ]
        : [
            "--prompt-file",
            `${cwd}/prompt.txt`,
            "--output-format",
            "streaming-messages-json",
            "--include-partial-messages",
            "--tools",
            "",
            "--no-subagents",
            "--disable-web-search",
          ];
  if (c.model) args.push("--model", c.model);
  let input = prompt;
  if (images.length) {
    if (c.provider === "codex")
      for (const path of images) args.push("--image", path);
    else if (c.provider === "claude") {
      args.push("--input-format", "stream-json");
      const content: any[] = [{ type: "text", text: prompt }];
      for (const path of images)
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: (
              await sharp(path)
                .resize({
                  width: 1000,
                  height: 1000,
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .jpeg()
                .toBuffer()
            ).toString("base64"),
          },
        });
      input =
        JSON.stringify({ type: "user", message: { role: "user", content } }) +
        "\n";
    } else
      throw Error(
        "当前主控 CLI 不支持图片审核输入，请将主控切换至 Claude Code、Codex 或视觉 API 模型",
      );
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error("任务已中断"));
    const child = spawn(c.executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: process.env,
    });
    let result = "",
      buffer = "",
      stderr = "",
      protocolError = "",
      stopReason = "",
      total = 0,
      stopping = false,
      settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder("utf8");
    const kill = () => {
      if (stopping || settled) return;
      stopping = true;
      try {
        process.kill(-child.pid!, "SIGINT");
      } catch {}
      forceTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 3000);
    };
    signal.addEventListener("abort", kill, { once: true });
    const stop = (reason: string) => {
      if (!stopReason) stopReason = reason;
      kill();
    };
    const guard = new CliActivityGuard(c.settings);
    const timeout = setInterval(() => {
      const reason = guard.reason();
      if (reason) stop(reason);
    }, 1000);
    const line = (value: string) => {
      if (stopReason || signal.aborted) return;
      if (Buffer.byteLength(value) > 8 * 1024 * 1024)
        return stop("CLI 单条消息超过 8 MB，本次任务已停止");
      if (!value.trim()) return;
      try {
        const e = JSON.parse(value);
        const decoded = decodeCliEvent(e);
        const next =
          decoded.text !== undefined
            ? decoded.text
            : decoded.delta !== undefined
              ? result + decoded.delta
              : undefined;
        if (next !== undefined && Buffer.byteLength(next) > 4 * 1024 * 1024)
          return stop("CLI 正文超过 4 MB，本次任务已停止");
        if (next !== undefined && next !== result) {
          guard.activity();
          result = next;
          onText(result);
        }
        if (decoded.error) protocolError = decoded.error;
        if (
          decoded.type &&
          ![
            "assistant",
            "content_block_delta",
            "agent_reasoning_delta",
            "agent_message_delta",
            "agent_reasoning",
            "stream_event",
          ].includes(decoded.type)
        )
          onEvent(`CLI · ${decoded.type}`);
      } catch {
        /* Startup output is not a successful delivery. */
      }
    };
    child.stdout.on("data", (data: Buffer) => {
      if (stopReason || signal.aborted || settled) return;
      total += data.length;
      // Protocol events may repeat full snapshots; this is not the document size.
      if (total > 256 * 1024 * 1024) {
        stop("CLI 累计协议流超过 256 MB，本次任务已停止");
        return;
      }
      buffer += decoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      lines.forEach(line);
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024)
        stop("CLI 单条消息超过 8 MB，本次任务已停止");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      signal.removeEventListener("abort", kill);
      if (err) reject(err);
      else resolve(result);
    };
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      line(buffer + decoder.end());
      if (signal.aborted) return finish(Error("任务已中断"));
      if (stopReason) return finish(Error(stopReason));
      if (code !== 0)
        return finish(
          Error(
            `CLI 退出 ${code}：${stderr.replace(/(?:sk-|xai-)[\w-]+/g, "[已隐藏]").slice(-800)}`,
          ),
        );
      if (!result.trim())
        return finish(
          Error(protocolError || "CLI 未交付文本结果，请检查适配事件格式"),
        );
      if (protocolError && ["claude", "grok-build"].includes(c.provider))
        return finish(Error(protocolError));
      finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(c.provider === "grok-build" ? "" : input);
  });
}

async function generateApi(
  c: Connection,
  prompt: string,
  signal: AbortSignal,
  images: string[] = [],
  onText: (text: string) => void = () => {},
) {
  const key = getCredential(c);
  if (!key) throw Error(`环境变量 ${c.keyEnv} 未配置`);
  const anthropic = c.provider === "anthropic";
  const endpoint =
    c.baseUrl.replace(/\/$/, "") +
    (anthropic ? "/messages" : "/chat/completions");
  let content: any = prompt;
  if (images.length) {
    content = [{ type: "text", text: prompt }];
    for (const path of images) {
      const data = (
        await sharp(path)
          .resize({
            width: 1000,
            height: 1000,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg()
          .toBuffer()
      ).toString("base64");
      content.push(
        anthropic
          ? {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data },
            }
          : {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${data}` },
            },
      );
    }
  }
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    headers: anthropic
      ? {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        }
      : { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: c.model,
      stream: c.settings?.stream !== false,
      max_tokens: 8000,
      messages: [{ role: "user", content }],
    }),
  });
  if (!response.ok)
    throw Error(
      `API 请求失败 HTTP ${response.status}；请检查连接、额度或限流状态`,
    );
  if (response.headers.get("content-type")?.includes("text/event-stream"))
    return readTextStream(response, onText);
  const json = (await response.json()) as any;
  const result = anthropic
    ? json.content
        ?.filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join("\n")
    : json.choices?.[0]?.message?.content;
  if (typeof result !== "string" || !result.trim())
    throw Error("API 未返回文本结果");
  onText(result);
  return result;
}

export async function readTextStream(
  response: Response,
  onText: (text: string) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("API 返回空流");
  const decoder = new TextDecoder();
  let buffer = "",
    result = "",
    size = 0,
    completed = false;
  const event = (raw: string) => {
    const payload = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!payload) return;
    if (payload === "[DONE]") {
      completed = true;
      return;
    }
    const e = JSON.parse(payload);
    if (e.error || e.type === "error")
      throw Error("API 流式执行失败，请检查供应商状态");
    if (e.type === "message_stop" || e.choices?.[0]?.finish_reason)
      completed = true;
    const delta =
      e.choices?.[0]?.delta?.content ??
      (e.type === "content_block_delta" && e.delta?.type === "text_delta"
        ? e.delta.text
        : e.type === "content_block_start" && e.content_block?.type === "text"
          ? e.content_block.text
          : undefined);
    if (typeof delta === "string") {
      result += delta;
      onText(result);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw Error("API 输出超过 4 MB");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let pos: number;
      while ((pos = buffer.indexOf("\n\n")) >= 0) {
        event(buffer.slice(0, pos));
        buffer = buffer.slice(pos + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    if (!completed) throw Error("API 流意外结束，草稿已保留，不能视为完整交付");
    if (!result.trim()) throw Error("API 未返回文本结果");
    return result;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

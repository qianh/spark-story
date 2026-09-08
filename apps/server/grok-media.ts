import { mkdir, readFile, lstat, realpath, copyFile } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { generate } from "./connectors";
import type { Connection } from "../../packages/domain";
import type { MediaJob } from "../../packages/media";

export function grokResultPath(root: string, id: string) {
  return resolve(root, "runs", "media-cli", id, "output.json");
}
// Accept paths only from successful native tool results, never from assistant prose.
export function toolMediaPaths(event: any): string[] {
  const paths: string[] = [];
  const inspect = (value: any) => {
    if (typeof value === "string") {
      try {
        inspect(JSON.parse(value));
      } catch {}
      return;
    }
    if (!value || typeof value !== "object") return;
    if (
      typeof value.path === "string" &&
      value.path.startsWith("/") &&
      /\.(png|jpe?g|webp|mp4)$/i.test(value.path)
    )
      paths.push(value.path);
    if (Array.isArray(value)) value.forEach(inspect);
    else
      for (const [key, child] of Object.entries(value))
        if (key !== "path") inspect(child);
  };
  for (const block of event.message?.content || [])
    if (block.type === "tool_result" && !block.is_error) inspect(block.content);
  return paths;
}
export async function runGrokMedia(
  c: Connection,
  job: MediaJob,
  root: string,
  references: string[],
  signal: AbortSignal,
  event: (message: string) => void,
) {
  const cwd = resolve(root, "runs", "media-cli", job.id);
  await mkdir(cwd, { recursive: true });
  const cache = grokResultPath(root, job.id);
  const o = JSON.parse(job.options);
  const accepted = (path: string) =>
    job.kind === "image"
      ? /\.(png|jpe?g|webp)$/i.test(path)
      : /\.mp4$/i.test(path);
  if (!existsSync(cache)) {
    const refs = await Promise.all(
      references.map(async (path, i) => {
        const target = join(cwd, `reference-${i + 1}${extname(path)}`);
        await copyFile(path, target);
        return target;
      }),
    );
    const tools =
      job.kind === "image"
        ? [refs.length ? "image_edit" : "image_gen"]
        : refs.length
          ? ["image_to_video"]
          : ["image_gen", "image_to_video"];
    const prompt = `你是媒体工具执行器。直接使用提供的原生媒体工具完成一次交付，不规划多镜头，不调用 shell、网络搜索或其他工具，不重复付费重试。工具报错就报告原始原因，不要换渠道。\n${job.kind === "image" ? (refs.length ? "使用 image_edit，image 数组传入全部参考绝对路径。" : "使用 image_gen。") : refs.length ? "只使用 image_to_video，image 为给定首帧。" : "先用 image_gen 生成一张符合要求的首帧，再用 image_to_video 动画化，不能返回只有图片的结果。"}\n参数：aspect_ratio=${o.aspect || "9:16"}${job.kind === "video" ? `，duration=${o.duration}，resolution_name=${o.resolution || "480p"}` : ""}。单图编辑可能沿用输入比例，不得声称参数一定生效。\n参考图绝对路径：${JSON.stringify(refs)}\n视觉要求：\n${job.prompt}\n完成后返回 JSON {"path":"工具返回的真实绝对路径"}。不能编造文件路径。`;
    const executionPrompt = job.kind === "image"
      ? `${prompt}\n生图文本已经编译完成。调用 ${refs.length ? "image_edit" : "image_gen"} 时，prompt 参数必须逐字使用下面 JSON 字符串解码后的文本，不翻译、不润色、不扩写、不删减，不将工具执行说明加入图片提示词：\n${JSON.stringify(job.prompt)}`
      : prompt;
    await Bun.write(join(cwd, "prompt.txt"), executionPrompt);
    const sessionId = crypto.randomUUID();
    await Bun.write(
      join(cwd, "request.json"),
      JSON.stringify(
        { sessionId, tools, kind: job.kind, options: o, references: refs },
        null,
        2,
      ),
    );
    const startedTools = new Set<string>();
    let invalidImageRequest = false;
    await generate(c, executionPrompt, cwd, signal, event, [], () => {}, {
      tools,
      sessionId,
      onProtocol: (message) => {
        for (const block of message.message?.content || [])
          if (
            block.type === "tool_use" &&
            tools.includes(block.name) &&
            !startedTools.has(block.id)
          ) {
            startedTools.add(block.id);
            // Keep the actual tool input, not just the instructions sent to the CLI agent.
            const raw = block.input ?? block.arguments;
            let input = raw;
            if (typeof raw === "string") {
              try { input = JSON.parse(raw); } catch {}
            }
            const promptMatches = input?.prompt === job.prompt;
            writeFileSync(join(cwd, `tool-call-${startedTools.size}.json`), JSON.stringify({
              tool: block.name, input, expectedPrompt: job.prompt, promptMatches,
            }, null, 2));
            if (job.kind === "image" && (!promptMatches ||
                (refs.length && JSON.stringify(input?.image) !== JSON.stringify(refs)))) {
              invalidImageRequest = true;
              event("实际生图提示词或参考图与编译请求不同，此次图片不会作为合格结果入库");
            }
            event(`Grok ${block.name} 正在生成；等待供应商返回真实文件`);
          }
        for (const path of toolMediaPaths(message))
          if (accepted(path) && !refs.includes(path) && !invalidImageRequest) {
            writeFileSync(cache, JSON.stringify({ path, sessionId }));
            event("Grok 原生媒体工具已返回文件，正在校验并入库");
          }
      },
    });
    if (invalidImageRequest) throw Error("Grok 改写了提示词或遗漏/重排参考图，拒绝接纳此次生成结果");
    if (!existsSync(cache))
      throw Error(
        "Grok CLI 未返回可验证的媒体工具文件；请检查账号媒体权限、工具是否可用及执行记录，不能把文字答复当成图片或视频",
      );
  } else event("恢复已完成的 CLI 媒体文件，不重新提交生成");
  const { path } = JSON.parse(await readFile(cache, "utf8"));
  if (typeof path !== "string" || !accepted(path))
    throw Error("CLI 媒体文件类型不匹配");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > 200 * 1024 * 1024
  )
    throw Error("CLI 媒体文件不是有效普通文件或超过 200 MB");
  const canonical = await realpath(path);
  if (
    await Promise.all(references.map((p) => realpath(p))).then((paths) =>
      paths.includes(canonical),
    )
  )
    throw Error("CLI 返回了输入参考图而非生成产物");
  if (signal.aborted) throw Error("任务已中断");
  return {
    bytes: await readFile(canonical),
    mime:
      job.kind === "video"
        ? "video/mp4"
        : /\.png$/i.test(path)
          ? "image/png"
          : /\.webp$/i.test(path)
            ? "image/webp"
            : "image/jpeg",
  };
}

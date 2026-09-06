import { isMediaStage } from "../../packages/series";
import { resolve, join, sep } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { Store } from "./store";
import { Runtime } from "./runtime";
import { probe } from "./connectors";
import { loadCredentials, saveCredential } from "./credentials";
import {
  projectInput,
  connectionInput,
  roles,
  templates,
} from "../../packages/domain";
import { z } from "zod";
import {
  mediaKinds,
  mediaBundle,
  assetPlanSchema,
  storyboardSchema,
  timelineSchema,
} from "../../packages/media";

const port = Number(process.env.PORT || 4310);
const root = resolve(process.env.SPARK_DATA_DIR || ".spark-story");
mkdirSync(root, { recursive: true, mode: 0o700 });
loadCredentials(root);
const store = new Store(join(root, "state.sqlite"));
store.recover();
const runtime = new Runtime(store, root);
for (const [provider, name, binary] of [
  ["codex", "Codex CLI", "codex"],
  ["claude", "Claude Code", "claude"],
  ["grok-build", "Grok Build", "grok"],
] as const) {
  if (!store.connections().some((c) => c.provider === provider)) {
    const executable = Bun.which(binary);
    if (executable)
      store.saveConnection({
        id: crypto.randomUUID(),
        name,
        provider,
        transport: "cli",
        executable,
        model: "",
        baseUrl: "",
        keyEnv: "",
        reserveCents: 0,
        health: "unverified",
        version: "",
      });
  }
}
const initialConnection =
  store.connections().find((c) => c.provider === "claude") ||
  store.connections().find((c) => c.provider === "codex");
if (initialConnection)
  for (const role of ["主模型", "文本模型"])
    store.db.run("INSERT OR IGNORE INTO bindings VALUES(?,?)", [
      role,
      initialConnection.id,
    ]);
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
const body = async (req: Request) => {
  const text = await req.text();
  if (text.length > 2500000) throw Error("请求内容过大");
  return JSON.parse(text);
};
const revision = z.object({ revision: z.number().int().positive() });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 60,
  maxRequestBodySize: 256 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
    const host = url.hostname;
    if (!["127.0.0.1", "localhost"].includes(host))
      return json({ error: "不允许的主机" }, 403);
    const origin = req.headers.get("origin");
    if (
      origin &&
      ![
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ].includes(origin)
    )
      return json({ error: "不允许的来源" }, 403);
    if (req.headers.get("sec-fetch-site") === "cross-site")
      return json({ error: "不允许跨站请求" }, 403);
    if (
      ["POST", "PATCH", "PUT"].includes(req.method) &&
      !req.headers.get("content-type")?.startsWith("application/json") &&
      !path.endsWith("/upload")
    )
      return json({ error: "需要 JSON 请求" }, 415);
    try {
      if (path === "/api/bootstrap")
        return json({
          projects: store.list(
            "SELECT * FROM projects ORDER BY createdAt DESC",
          ),
          connections: store.connections(),
          bindings: store.list("SELECT * FROM bindings"),
          version: "0.3.0",
          capabilities: { text: true, media: true },
        });
      if (path === "/api/projects" && req.method === "POST")
        return json(
          store.createProject(projectInput.parse(await body(req))),
          201,
        );
      const project = path.match(/^\/api\/projects\/([^/]+)$/);
      const production = path.match(/^\/api\/projects\/([^/]+)\/production$/);
      if (production && req.method === "PUT")
        return json(store.saveProductionRules(production[1], await body(req)));
      if (project && req.method === "GET") return json(store.board(project[1]));
      if (project && req.method === "PATCH") {
        const value = z
          .object({
            budget: z.number().int().min(0).max(100000000).optional(),
            template: z
              .string()
              .refine((v) => templates.some((t) => t.id === v))
              .optional(),
          })
          .refine((v) => v.budget !== undefined || v.template !== undefined)
          .parse(await body(req));
        store.project(project[1]);
        if (value.budget !== undefined)
          store.db.run("UPDATE projects SET budget=? WHERE id=?", [
            value.budget,
            project[1],
          ]);
        if (value.template) store.setVisualTemplate(project[1], value.template);
        return json({ ok: true });
      }
      if (path === "/api/connections" && req.method === "POST") {
        const input = await body(req);
        const apiKey = z.string().max(4000).optional().parse(input.apiKey);
        if (apiKey) input.keyEnv = "SPARK_LOCAL_KEY";
        const c = connectionInput.parse(input);
        const saved = {
          ...c,
          id: c.id || crypto.randomUUID(),
          health: "unverified",
          version: "",
        };
        if (apiKey) saveCredential(saved.id, apiKey);
        store.saveConnection(saved);
        return json(saved);
      }
      const connection = path.match(/^\/api\/connections\/([^/]+)\/probe$/);
      if (connection && req.method === "POST") {
        const c = store.connection(connection[1]);
        const info = await probe(c);
        store.saveConnection({ ...c, ...info });
        return json(info);
      }
      if (path === "/api/bindings" && req.method === "POST") {
        const value = z
          .object({
            role: z.enum([...roles, "其他:口型"]),
            connectionId: z.string(),
          })
          .parse(await body(req));
        store.connection(value.connectionId);
        store.db.run(
          "INSERT INTO bindings VALUES(?,?) ON CONFLICT(role) DO UPDATE SET connectionId=excluded.connectionId",
          [value.role, value.connectionId],
        );
        return json({ ok: true });
      }
      const chapterRepair = path.match(
        /^\/api\/tasks\/([^/]+)\/repair-chapter$/,
      );
      if (chapterRepair && req.method === "POST") {
        const value = z
          .object({
            revision: z.number().int().positive(),
            chapterId: z.string().min(1),
            instruction: z.string().trim().min(1).max(10000),
          })
          .parse(await body(req));
        runtime.repairChapter(
          chapterRepair[1],
          value.revision,
          value.chapterId,
          value.instruction,
        );
        return json({ ok: true });
      }
      const retryAsset = path.match(/^\/api\/tasks\/([^/]+)\/retry-asset$/);
      if (retryAsset && req.method === "POST") {
        const value = revision
          .extend({ assetId: z.string().min(1).max(120) })
          .parse(await body(req));
        return json(
          await runtime.retryAsset(
            retryAsset[1],
            value.revision,
            value.assetId,
          ),
        );
      }
      const task = path.match(
        /^\/api\/tasks\/([^/]+)\/(start|interrupt|approve|edit)$/,
      );
      if (task && req.method === "POST") {
        const input = await body(req);
        const { revision: r } = revision.parse(input);
        if (task[2] === "start") runtime.start(task[1], r);
        if (task[2] === "interrupt")
          runtime.intervene(
            task[1],
            r,
            z
              .string()
              .max(10000)
              .parse(input.message || ""),
          );
        if (task[2] === "approve")
          store.approve(task[1], r, z.string().parse(input.artifactId));
        if (task[2] === "edit") {
          const content = z
            .string()
            .trim()
            .min(1)
            .max(2000000)
            .parse(input.content);
          if (isMediaStage(store.task(task[1]).stage)) {
            const bundle = mediaBundle(content);
            if (!bundle) throw Error("媒体阶段需要有效的结构化产物");
            const expected = [
              "",
              "",
              "",
              "assets",
              "storyboard",
              "production",
              "timeline",
            ][store.task(task[1]).stage];
            if (bundle.type !== expected)
              throw Error("产物类型与制作阶段不匹配");
            (
              ({
                assets: assetPlanSchema,
                storyboard: storyboardSchema,
                production: storyboardSchema,
                timeline: timelineSchema,
              }) as any
            )[bundle.type].parse(bundle.data);
          }
          const t = store.task(task[1]);
          if (t.revision !== r) throw Error("版本已变化");
          runtime.intervene(t.id, r, "");
          const changed = store.task(t.id);
          store.db.run(
            "DELETE FROM planning_checkpoints WHERE taskId=? AND revision=?",
            [t.id, changed.revision],
          );
          store.publish(t.id, changed.revision, content);
          store.event(
            t.projectId,
            t.id,
            "artifact.edited",
            "用户直接编辑已保存为新候选；点击开始执行可直接交主控审核。",
          );
        }
        return json({ ok: true }, 202);
      }
      const confirm = path.match(/^\/api\/interventions\/([^/]+)\/confirm$/);
      if (confirm && req.method === "POST") {
        runtime.confirm(confirm[1]);
        return json({ ok: true }, 202);
      }
      if (path === "/api/events") {
        const after = Number(url.searchParams.get("after") || 0),
          projectId = url.searchParams.get("project") || "";
        return json(
          store.list(
            "SELECT * FROM events WHERE seq>? AND projectId=? ORDER BY seq LIMIT 200",
            Number.isFinite(after) ? after : 0,
            projectId,
          ),
        );
      }
      const mediaFile = path.match(/^\/api\/media\/files\/([^/]+)$/);
      if (mediaFile && req.method === "GET") {
        const file = runtime.media.files.get(mediaFile[1]),
          data = Bun.file(file.path),
          size = data.size;
        const headers: Record<string, string> = {
          "content-type": file.mime,
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff",
        };
        if (url.searchParams.has("download"))
          headers["content-disposition"] =
            `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;
        const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          const start = Number(range[1]),
            end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size)
            return new Response(null, {
              status: 416,
              headers: { "content-range": `bytes */${size}` },
            });
          return new Response(data.slice(start, end + 1), {
            status: 206,
            headers: {
              ...headers,
              "content-range": `bytes ${start}-${end}/${size}`,
              "content-length": String(end - start + 1),
            },
          });
        }
        return new Response(data, { headers });
      }
      const upload = path.match(/^\/api\/projects\/([^/]+)\/upload$/);
      if (upload && req.method === "POST") {
        const form = await req.formData(),
          file = form.get("file");
        if (!(file instanceof File)) throw Error("请选择素材文件");
        const taskId = z.string().parse(form.get("taskId"));
        const task = store.task(taskId);
        if (task.projectId !== upload[1]) throw Error("任务不属于此项目");
        if (!/^(image\/(png|jpeg|webp)|audio\/|video\/)/.test(file.type))
          throw Error("支持 PNG/JPEG/WebP 图片、音频和视频");
        const saved = await runtime.media.files.add(
          upload[1],
          taskId,
          task.revision,
          file.name,
          new Uint8Array(await file.arrayBuffer()),
          file.type,
        );
        return json({ ...saved, path: undefined });
      }
      if (path === "/api/media/jobs" && req.method === "POST") {
        const input = z
          .object({
            taskId: z.string(),
            revision: z.number().int().positive(),
            kind: z.enum(mediaKinds),
            prompt: z.string().min(1).max(20000),
            inputs: z.array(z.string()).default([]),
            options: z.record(z.unknown()).default({}),
            connectionId: z.string().optional(),
          })
          .parse(await body(req));
        const job = runtime.media.create(
          input.taskId,
          input.revision,
          input.kind,
          input.prompt,
          input.inputs,
          input.options,
          input.connectionId,
        );
        runtime.media.start(job.id);
        return json(job, 202);
      }
      const mediaAction = path.match(
        /^\/api\/media\/jobs\/([^/]+)\/(resume|stop|allow-retry)$/,
      );
      if (mediaAction && req.method === "POST") {
        if (mediaAction[2] === "stop") runtime.media.stop(mediaAction[1]);
        else if (mediaAction[2] === "allow-retry") {
          const j = runtime.media.job(mediaAction[1]);
          if (j.remoteId)
            throw Error("已存在供应商任务 ID，请继续查询而非重新提交");
          runtime.media.update(j.id, {
            status: "failed",
            error: "用户明确允许重新提交；旧费用记录保留",
          });
        } else runtime.media.start(mediaAction[1]);
        return json({ ok: true }, 202);
      }
      if (path.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
      const base = resolve("dist"),
        file = resolve(base, "." + decodeURIComponent(path));
      if (
        file.startsWith(base + sep) &&
        existsSync(file) &&
        (await Bun.file(file).stat()).isFile()
      )
        return new Response(Bun.file(file));
      if (existsSync(join(base, "index.html")))
        return new Response(Bun.file(join(base, "index.html")));
      return new Response(
        "前端尚未构建。开发时使用 bun run dev，或先执行 bun run build。",
        { status: 503 },
      );
    } catch (e) {
      return json(
        {
          error:
            e instanceof z.ZodError
              ? e.issues
                  .map(
                    (i) =>
                      (i.path.length ? i.path.join(".") + "：" : "") +
                      i.message,
                  )
                  .join("；")
              : e instanceof Error
                ? e.message
                : "请求失败",
        },
        400,
      );
    }
  },
});
console.log(`Spark Story: http://127.0.0.1:${server.port}`);
process.on("SIGINT", () => {
  runtime.shutdown();
  server.stop();
  setTimeout(() => process.exit(0), 3500);
});
process.on("SIGTERM", () => {
  runtime.shutdown();
  server.stop();
  setTimeout(() => process.exit(0), 3500);
});

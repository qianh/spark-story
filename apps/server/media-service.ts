import { runQwenTts, qwenReady, qwenOptions } from "./qwen-tts";
import { existsSync } from "node:fs";
import { prepareVisualRequest } from "../../packages/media-profiles";
import { runGrokMedia, grokResultPath } from "./grok-media";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Store } from "./store";
import { MediaFiles } from "./media-files";
import { getCredential } from "./credentials";
import type { Connection } from "../../packages/domain";
import type { MediaKind, MediaJob } from "../../packages/media";
const roleFor: Record<MediaKind, string> = {
  image: "图片模型",
  video: "视频模型",
  speech: "语音模型",
  music: "其他",
  sound: "其他",
  lipsync: "其他:口型",
};
const agentFor: Record<MediaKind, string> = {
  image: "角色与关键帧 Agent",
  video: "视频 Agent",
  speech: "配音 Agent",
  music: "音乐 Agent",
  sound: "音效 Agent",
  lipsync: "口型 Agent",
};
export class MediaService {
  files: MediaFiles;
  active = new Map<string, AbortController>();
  constructor(
    public store: Store,
    public root: string,
  ) {
    this.files = new MediaFiles(store, root);
  }
  connection(kind: MediaKind, override?: string) {
    const c = override
      ? this.store.connection(override)
      : this.store.binding(roleFor[kind]);
    this.validate(c, kind);
    return c;
  }
  validate(c: Connection, kind: MediaKind) {
    if (c.transport === "cli" && c.provider === "qwen-tts" && kind === "speech")
      return;
    if (
      c.transport === "cli" &&
      c.provider === "grok-build" &&
      ["image", "video"].includes(kind)
    )
      return;
    if (c.transport !== "api")
      throw Error(
        `${kind} 尚未支持此 CLI；图片和视频可使用 Grok Build CLI 或媒体 API`,
      );
    const supports: Record<string, string[]> = {
      openai: ["image", "video", "speech"],
      compatible: ["image", "video", "speech"],
      xai: ["image", "video"],
      gemini: ["image"],
      elevenlabs: ["speech", "music", "sound"],
      sync: ["lipsync"],
      "media-gateway": [
        "image",
        "video",
        "speech",
        "music",
        "sound",
        "lipsync",
      ],
    };
    if (!supports[c.provider]?.includes(kind))
      throw Error(`${c.name} 的协议不支持 ${kind}，请为该能力选择匹配连接`);
    if (!getCredential(c)) throw Error(`${c.name} 缺少 API Key`);
  }
  job(id: string) {
    const j = this.store.one<MediaJob>(
      "SELECT * FROM media_jobs WHERE id=?",
      id,
    );
    if (!j) throw Error("媒体任务不存在");
    return j;
  }
  update(id: string, patch: Partial<MediaJob>) {
    const columns = Object.keys(patch);
    this.store.db.run(
      `UPDATE media_jobs SET ${columns.map((k) => k + "=?").join(",")},updatedAt=? WHERE id=?`,
      [...Object.values(patch), new Date().toISOString(), id],
    );
  }
  create(
    taskId: string,
    revision: number,
    kind: MediaKind,
    prompt: string,
    inputs: string[] = [],
    options: Record<string, any> = {},
    override?: string,
    force = false,
  ) {
    const task = this.store.task(taskId);
    if (task.revision !== revision) throw Error("任务版本已变化");
    const c = this.connection(kind, override);
    const inputFiles = inputs.map((id) => this.files.get(id, task.projectId));
    if (
      ["image", "video"].includes(kind) &&
      inputFiles.some((f) => f.kind !== "image")
    )
      throw Error("图像与视频生成的参考素材必须是图片");
    if (kind === "video" && inputs.length > 1)
      throw Error("视频生成目前支持一张关键帧，请只选择一张参考图");
    if (
      kind === "lipsync" &&
      (inputs.length !== 2 ||
        inputFiles[0].kind !== "video" ||
        inputFiles[1].kind !== "audio")
    )
      throw Error("口型同步需要依次选择一个视频和一个配音文件");
    if (c.provider === "qwen-tts") qwenOptions({ ...c.settings, ...options });
    const prepared = prepareVisualRequest(c, kind, prompt, inputs.length, {
      ...c.settings,
      ...options,
    });
    prompt = prepared.prompt;
    const effective = prepared.options;
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          taskId,
          kind,
          prompt,
          inputs,
          options: effective,
          connection: c,
        }),
      )
      .digest("hex");
    if (!force) {
      const cached = this.store.one<MediaJob>(
        "SELECT * FROM media_jobs WHERE taskId=? AND operationKey=? AND status='completed' ORDER BY createdAt DESC LIMIT 1",
        taskId,
        key,
      );
      if (cached) return cached;
      const existing = this.store.one<MediaJob>(
        "SELECT * FROM media_jobs WHERE taskId=? AND operationKey=? AND status != 'failed' ORDER BY createdAt DESC LIMIT 1",
        taskId,
        key,
      );
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const j: MediaJob = {
      id: crypto.randomUUID(),
      projectId: task.projectId,
      taskId,
      revision,
      kind,
      agent: agentFor[kind],
      prompt,
      inputs: JSON.stringify(inputs),
      options: JSON.stringify(effective),
      connection: JSON.stringify(c),
      status: "queued",
      remoteId: "",
      outputId: "",
      error: "",
      costId: "",
      operationKey: key,
      createdAt: now,
      updatedAt: now,
    };
    this.store.db.run(
      "INSERT INTO media_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      Object.values(j),
    );
    this.store.event(
      j.projectId,
      j.taskId,
      "media.created",
      `${j.agent}：${prompt.slice(0, 100)}`,
    );
    return j;
  }
  async ensure(
    taskId: string,
    revision: number,
    kind: MediaKind,
    prompt: string,
    inputs: string[],
    options: Record<string, any>,
    signal: AbortSignal,
    override?: string,
    force = false,
  ) {
    const j = this.create(
      taskId,
      revision,
      kind,
      prompt,
      inputs,
      options,
      override,
      force,
    );
    return this.run(j.id, signal);
  }
  start(id: string) {
    if (this.active.has(id)) throw Error("媒体任务正在执行");
    void this.run(id).catch(() => {});
  }
  stop(id: string) {
    const j = this.job(id);
    if (j.status === "completed") throw Error("已完成的媒体任务不能中断");
    this.active.get(id)?.abort();
    this.update(id, {
      status: j.remoteId ? "detached" : "cancelled",
      error: j.remoteId
        ? "本地已中断，供应商仍可能执行；可继续查询"
        : "本地已中断",
    });
    this.store.event(
      j.projectId,
      j.taskId,
      "agent.interrupted",
      `${j.agent} 已停止自己的本地执行并上报主控；其他任务未被该子 Agent 停止。`,
    );
  }
  stopTask(taskId: string) {
    for (const id of this.active.keys())
      if (this.job(id).taskId === taskId) this.stop(id);
  }
  async run(id: string, parent?: AbortSignal): Promise<string> {
    let job = this.job(id);
    if (job.status === "completed") return job.outputId;
    if (this.active.has(id)) throw Error("该媒体任务正在执行");
    if (
      ["submitting", "downloading", "unknown", "cancelled"].includes(
        job.status,
      ) &&
      !job.remoteId &&
      !(
        (JSON.parse(job.connection).provider === "grok-build" &&
          existsSync(grokResultPath(this.root, job.id))) ||
        (JSON.parse(job.connection).provider === "qwen-tts" &&
          existsSync(qwenReady(this.root, job.id)))
      )
    )
      throw Error(
        "供应商提交结果未知或已取消，请核实账单后显式标记重试，不能重复扣费",
      );
    const c = JSON.parse(job.connection) as Connection;
    this.validate(c, job.kind);
    const controller = new AbortController();
    this.active.set(id, controller);
    const signal = parent
      ? AbortSignal.any([parent, controller.signal])
      : controller.signal;
    const options = JSON.parse(job.options),
      inputs = JSON.parse(job.inputs) as string[];
    try {
      if (signal.aborted) throw Error("任务已中断");
      let result: any;
      if (job.remoteId) {
        this.update(id, { status: "polling", error: "" });
        result = await this.poll(job, c, signal);
      } else {
        const reservation = this.store.reserve(job.projectId, id, c);
        this.update(id, {
          status: "submitting",
          costId: reservation || "",
          error: "",
        });
        job = this.job(id);
        result = await this.submit(job, c, options, inputs, signal);
        if (result.remoteId) {
          this.update(id, { remoteId: result.remoteId, status: "polling" });
          job = this.job(id);
          result = await this.poll(job, c, signal);
        }
      }
      this.update(id, { status: "downloading" });
      const { bytes, mime } = result.bytes
        ? result
        : await this.download(result.url, c, signal, result.authenticated);
      const kind =
        job.kind === "image"
          ? "image"
          : job.kind === "video" || job.kind === "lipsync"
            ? "video"
            : "audio";
      const f = await this.files.add(
        job.projectId,
        job.taskId,
        job.revision,
        `${job.agent}-${job.id.slice(0, 8)}.${kind === "image" ? "png" : kind === "video" ? "mp4" : mime?.includes("wav") ? "wav" : "mp3"}`,
        bytes,
        mime ||
          `${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "mpeg"}`,
      );
      this.update(id, { status: "completed", outputId: f.id, error: "" });
      const current = this.job(id);
      if (current.costId)
        this.store.db.run("UPDATE costs SET status='provisional' WHERE id=?", [
          current.costId,
        ]);
      this.store.event(
        job.projectId,
        job.taskId,
        "media.completed",
        `${job.agent} 完成，实际产物已下载并通过文件校验。`,
      );
      return f.id;
    } catch (e) {
      const current = this.job(id),
        error = e instanceof Error ? e.message : String(e);
      const status =
        c.transport === "cli" && current.status !== "queued"
          ? existsSync(grokResultPath(this.root, job.id)) ||
            existsSync(qwenReady(this.root, job.id))
            ? "detached"
            : "unknown"
          : signal.aborted
            ? current.remoteId
              ? "detached"
              : current.status === "queued"
                ? "cancelled"
                : "unknown"
            : current.remoteId
              ? "poll_error"
              : current.status === "submitting"
                ? "unknown"
                : "failed";
      this.update(id, { status, error });
      if (current.costId)
        this.store.db.run(
          "UPDATE costs SET status='unknown' WHERE id=? AND status='reserved'",
          [current.costId],
        );
      this.store.event(job.projectId, job.taskId, "media.error", error);
      throw e;
    } finally {
      this.active.delete(id);
    }
  }
  async request(
    c: Connection,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    const key = getCredential(c)!;
    const headers: Record<string, string> =
      c.provider === "sync"
        ? { "x-api-key": key }
        : c.provider === "elevenlabs"
          ? { "xi-api-key": key }
          : c.provider === "gemini"
            ? { "x-goog-api-key": key }
            : { authorization: `Bearer ${key}` };
    if (body && !(body instanceof FormData))
      headers["content-type"] = "application/json";
    const r = await fetch(c.baseUrl.replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      headers,
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
    });
    if (!r.ok)
      throw Error(
        `${c.name} HTTP ${r.status}：${(await r.text()).replaceAll(key, "[已隐藏]").slice(0, 900)}`,
      );
    return r;
  }
  async submit(
    j: MediaJob,
    c: Connection,
    o: Record<string, any>,
    ids: string[],
    signal: AbortSignal,
  ): Promise<any> {
    if (c.provider === "qwen-tts")
      return runQwenTts(c, j, this.root, signal, (message) =>
        this.store.event(j.projectId, j.taskId, "media.local", message),
      );
    if (c.transport === "cli")
      return runGrokMedia(
        c,
        j,
        this.root,
        ids.map((id) => this.files.get(id, j.projectId).path),
        signal,
        (message) =>
          this.store.event(j.projectId, j.taskId, "media.cli", message),
      );
    const model = c.model,
      refs = await Promise.all(
        ids.map((id) => this.files.dataUrl(id, j.projectId)),
      );
    if (c.provider === "sync") {
      if (ids.length !== 2) throw Error("口型同步需要一段视频和一段配音");
      const input = [];
      for (const id of ids) {
        const f = this.files.get(id, j.projectId),
          bytes = await readFile(f.path);
        const presign = (await (
          await this.request(c, "/assets/upload", signal, {
            fileName: f.name,
            contentType: f.mime,
            size: bytes.length,
          })
        ).json()) as any;
        const uploaded = await fetch(presign.uploadUrl, {
          method: "PUT",
          headers: { "content-type": f.mime },
          body: bytes,
          signal,
        });
        if (!uploaded.ok) throw Error("口型素材上传失败");
        const asset = (await (
          await this.request(c, "/assets", signal, {
            url: presign.url,
            type: f.kind.toUpperCase(),
            name: f.name,
          })
        ).json()) as any;
        input.push({ type: f.kind, assetId: asset.id });
      }
      const result = (await (
        await this.request(c, "/generate", signal, {
          model,
          input,
          options: { sync_mode: "cut_off" },
        })
      ).json()) as any;
      if (!result.id) throw Error("口型同步未返回任务 ID");
      return { remoteId: result.id };
    }
    if (c.provider === "media-gateway") {
      const r = await this.request(c, "/generate", signal, {
        kind: j.kind,
        model,
        prompt: j.prompt,
        inputs: refs,
        options: o,
        request_id: j.id,
      });
      if (!r.headers.get("content-type")?.includes("json"))
        return {
          bytes: await readBounded(r),
          mime: r.headers.get("content-type"),
        };
      const b = (await r.json()) as any;
      return b.job_id
        ? { remoteId: b.job_id }
        : b.b64
          ? { bytes: Buffer.from(b.b64, "base64"), mime: b.mime }
          : { url: b.url };
    }
    if (j.kind === "image") {
      if (c.provider === "gemini") {
        const parts: any[] = [{ text: j.prompt }];
        for (const id of ids) {
          const f = this.files.get(id, j.projectId);
          parts.push({
            inlineData: {
              mimeType: f.mime,
              data: (await readFile(f.path)).toString("base64"),
            },
          });
        }
        const r = await this.request(
          c,
          `/models/${encodeURIComponent(model)}:generateContent`,
          signal,
          {
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: {
                aspectRatio: o.aspect || "9:16",
                ...(o.imageSize ? { imageSize: o.imageSize } : {}),
              },
            },
          },
        );
        const data = (await r.json()) as any;
        const image = data.candidates?.[0]?.content?.parts?.find(
          (p: any) => p.inlineData || p.inline_data,
        );
        const value = image?.inlineData || image?.inline_data;
        if (!value) throw Error("图像模型没有返回图片");
        return {
          bytes: Buffer.from(value.data, "base64"),
          mime: value.mimeType || value.mime_type,
        };
      }
      let r: Response;
      if (c.provider === "xai") {
        r = await this.request(
          c,
          ids.length ? "/images/edits" : "/images/generations",
          signal,
          {
            model,
            prompt: j.prompt,
            n: 1,
            aspect_ratio: o.aspect || "9:16",
            ...(refs.length > 1
              ? { images: refs.map((url) => ({ type: "image_url", url })) }
              : refs[0]
                ? { image: { url: refs[0] } }
                : {}),
          },
        );
      } else if (ids.length) {
        const f = new FormData();
        f.set("model", model);
        f.set("prompt", j.prompt);
        f.set("size", o.size || imageSize(o.aspect));
        if (o.quality) f.set("quality", o.quality);
        for (const id of ids) {
          const file = this.files.get(id, j.projectId);
          f.append(
            "image[]",
            new Blob([await readFile(file.path)], { type: file.mime }),
            file.name,
          );
        }
        r = await this.request(c, "/images/edits", signal, f);
      } else
        r = await this.request(c, "/images/generations", signal, {
          model,
          prompt: j.prompt,
          n: 1,
          size: o.size || imageSize(o.aspect),
          ...(o.quality ? { quality: o.quality } : {}),
        });
      const data = (await r.json()) as any;
      const image = data.data?.[0];
      if (!image) throw Error("供应商没有返回图像产物");
      return image.b64_json
        ? { bytes: Buffer.from(image.b64_json, "base64"), mime: "image/png" }
        : { url: image.url };
    }
    if (j.kind === "video") {
      if (c.provider === "xai") {
        const r = await this.request(c, "/videos/generations", signal, {
          model,
          prompt: j.prompt,
          duration: Math.ceil(o.duration || 6),
          ...(o.resolution ? { resolution: o.resolution } : {}),
          ...(typeof o.generateAudio === "boolean"
            ? { generate_audio: o.generateAudio }
            : {}),
          aspect_ratio: o.aspect || "9:16",
          ...(refs[0] ? { image: { url: refs[0] } } : {}),
        });
        const data = (await r.json()) as any;
        if (!data.request_id) throw Error("视频提交未返回任务 ID");
        return { remoteId: data.request_id };
      }
      const f = new FormData();
      f.set("model", model);
      f.set("prompt", j.prompt);
      f.set(
        "seconds",
        String(
          o.seconds || [4, 8, 12].find((n) => n >= (o.duration || 4)) || 12,
        ),
      );
      f.set(
        "size",
        o.size || ((o.aspect || "9:16") === "16:9" ? "1280x720" : "720x1280"),
      );
      if (ids[0]) {
        const image = this.files.get(ids[0], j.projectId);
        const [width, height] = String(f.get("size")).split("x").map(Number);
        const sharp = (await import("sharp")).default;
        const png = await sharp(image.path)
          .resize(width, height, { fit: "contain", background: "black" })
          .png()
          .toBuffer();
        f.set(
          "input_reference",
          new Blob([png], { type: "image/png" }),
          "reference.png",
        );
      }
      const data = (await (
        await this.request(c, "/videos", signal, f)
      ).json()) as any;
      if (!data.id) throw Error("视频提交未返回任务 ID");
      return { remoteId: data.id };
    }
    if (j.kind === "speech") {
      const r =
        c.provider === "elevenlabs"
          ? await this.request(
              c,
              `/text-to-speech/${encodeURIComponent(o.voice || "")}`,
              signal,
              { model_id: model, text: j.prompt },
            )
          : await this.request(c, "/audio/speech", signal, {
              model,
              input: j.prompt,
              voice: o.voice || "alloy",
              response_format: "mp3",
              ...(o.instructions ? { instructions: o.instructions } : {}),
            });
      return {
        bytes: await readBounded(r),
        mime: r.headers.get("content-type") || "audio/mpeg",
      };
    }
    if (j.kind === "music" || j.kind === "sound") {
      const r = await this.request(
        c,
        j.kind === "music" ? "/music" : "/sound-generation",
        signal,
        j.kind === "music"
          ? {
              model_id: model,
              prompt: j.prompt,
              music_length_ms: Math.round(
                Math.max(3, Math.min(600, o.duration || 30)) * 1000,
              ),
              force_instrumental: true,
            }
          : {
              model_id: o.soundModel || "eleven_text_to_sound_v2",
              text: j.prompt,
              duration_seconds: Math.max(0.5, Math.min(30, o.duration || 5)),
            },
      );
      return { bytes: await readBounded(r), mime: "audio/mpeg" };
    }
    throw Error("该协议没有对应的媒体操作");
  }
  async poll(j: MediaJob, c: Connection, signal: AbortSignal): Promise<any> {
    for (let i = 0; i < 720; i++) {
      if (signal.aborted) throw Error("任务已中断");
      const path =
        c.provider === "sync"
          ? `/generate/${encodeURIComponent(j.remoteId)}`
          : c.provider === "media-gateway"
            ? `/jobs/${encodeURIComponent(j.remoteId)}`
            : `/videos/${encodeURIComponent(j.remoteId)}`;
      const data = (await (await this.request(c, path, signal)).json()) as any;
      const status = String(data.status).toLowerCase();
      if (
        ["failed", "error", "cancelled", "expired", "rejected"].includes(status)
      )
        throw Error(
          `供应商任务失败：${JSON.stringify(data.error || data.status)}`,
        );
      if (["done", "completed", "succeeded"].includes(status)) {
        if (c.provider === "openai" || c.provider === "compatible")
          return {
            url:
              c.baseUrl.replace(/\/$/, "") +
              `/videos/${encodeURIComponent(j.remoteId)}/content`,
            authenticated: true,
          };
        return {
          url:
            data.outputUrl || data.video?.url || data.url || data.output?.url,
        };
      }
      if (i % 6 === 0)
        this.store.event(
          j.projectId,
          j.taskId,
          "media.poll",
          `${j.agent}：供应商 ${data.status || "处理中"}${typeof data.progress === "number" ? ` ${data.progress}%` : ""}`,
        );
      await new Promise<void>((res, rej) => {
        const onAbort = () => {
          clearTimeout(t);
          rej(Error("任务已中断"));
        };
        const t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          res();
        }, 5000);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw Error("视频任务等待超过 1 小时，任务 ID 已保存，可继续查询");
  }
  async download(
    url: string,
    c: Connection,
    signal: AbortSignal,
    authenticated = false,
  ) {
    if (!url) throw Error("供应商未提供可下载的媒体地址");
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol))
      throw Error("无效媒体下载地址");
    const headers: Record<string, string> = {};
    if (authenticated) {
      if (parsed.origin !== new URL(c.baseUrl).origin)
        throw Error("受认证下载地址与供应商不匹配");
      headers.authorization = `Bearer ${getCredential(c)}`;
    }
    const r = await fetch(url, {
      headers,
      redirect: authenticated ? "error" : "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
    });
    if (!r.ok) throw Error(`下载失败 HTTP ${r.status}，任务记录已保留`);
    return {
      bytes: await readBounded(r),
      mime: r.headers.get("content-type")?.split(";")[0],
    };
  }
  async transcribe(fileId: string, signal: AbortSignal) {
    const file = this.files.get(fileId),
      speech = this.connection("speech"),
      c =
        speech.provider === "qwen-tts"
          ? typeof speech.settings?.transcriptionConnectionId === "string"
            ? this.connection(
                "speech",
                speech.settings.transcriptionConnectionId,
              )
            : null
          : speech;
    if (!c || c.transport !== "api")
      throw Error(
        "本地配音已保存；Qwen3-TTS 不提供语音识别，请在连接高级参数配置 transcriptionConnectionId 指向支持转写的 API 连接后继续审核",
      );
    const cached = this.store.one<{ text: string }>(
      "SELECT text FROM media_transcripts WHERE fileId=? AND connectionId=?",
      fileId,
      c.id,
    );
    if (cached) return cached.text;
    const reservation = this.store.reserve(
      file.projectId,
      `transcribe-${file.id}`,
      c,
    );
    try {
      let result: any;
      if (c.provider === "media-gateway")
        result = await (
          await this.request(c, "/transcribe", signal, {
            audio: await this.files.dataUrl(file.id, file.projectId),
            model: c.settings?.transcriptionModel,
          })
        ).json();
      else {
        const form = new FormData();
        form.set(
          c.provider === "elevenlabs" ? "model_id" : "model",
          String(
            c.settings?.transcriptionModel ||
              (c.provider === "elevenlabs" ? "scribe_v1" : "whisper-1"),
          ),
        );
        form.set(
          "file",
          new Blob([await readFile(file.path)], { type: file.mime }),
          file.name,
        );
        result = await (
          await this.request(
            c,
            c.provider === "elevenlabs"
              ? "/speech-to-text"
              : "/audio/transcriptions",
            signal,
            form,
          )
        ).json();
      }
      if (typeof result.text !== "string") throw Error("语音转写没有返回文本");
      this.store.db.run(
        "INSERT OR REPLACE INTO media_transcripts VALUES(?,?,?)",
        [file.id, c.id, result.text],
      );
      if (reservation)
        this.store.db.run("UPDATE costs SET status='provisional' WHERE id=?", [
          reservation,
        ]);
      return result.text;
    } catch (e) {
      if (reservation)
        this.store.db.run("UPDATE costs SET status='unknown' WHERE id=?", [
          reservation,
        ]);
      throw e;
    }
  }
  shutdown() {
    for (const controller of this.active.values()) controller.abort();
  }
}
export async function readBounded(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("供应商返回空响应");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256 * 1024 * 1024) {
      await reader.cancel();
      throw Error("媒体超过 256 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function imageSize(aspect: string) {
  const [w, h] = (aspect || "9:16").split(":").map(Number);
  return w === h ? "1024x1024" : w > h ? "1536x1024" : "1024x1536";
}

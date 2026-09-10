import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { Store } from "./store";
import type { MediaFile, Timeline } from "../../packages/media";
import { durationIssues } from "../../packages/production";

const mediaIdKeys = new Set([
  "imageId",
  "audioId",
  "videoId",
  "musicId",
  "soundId",
  "previewId",
  "exportId",
  "dialogueTrackId",
  "mixedTrackId",
  "selectedCandidateId",
  "sourceAudioId",
  "subtitleId",
  "fileId",
]);
const mediaIdLists = new Set(["candidates", "generationReferenceIds"]);
export function referencedMediaIds(content: string) {
  const ids = new Set<string>();
  const named =
    /"(?:imageId|audioId|videoId|musicId|soundId|previewId|exportId|dialogueTrackId|mixedTrackId|selectedCandidateId|sourceAudioId|subtitleId|fileId)"\s*:\s*"([^"]+)"/g;
  for (const match of content.matchAll(named)) ids.add(match[1]);
  const lists =
    /"(?:candidates|generationReferenceIds)"\s*:\s*\[([^\]]*)\]/g;
  for (const match of content.matchAll(lists))
    for (const id of match[1].match(/"([^"]+)"/g) || [])
      ids.add(id.slice(1, -1));
  return [...ids];
}
export function stripReferencedMedia(content: string, deleted: Set<string>) {
  try {
    return JSON.stringify(stripMediaValue(JSON.parse(content), deleted));
  } catch {
    return content;
  }
}
function stripMediaValue(value: unknown, deleted: Set<string>): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => !(typeof item === "string" && deleted.has(item)))
      .map((item) => stripMediaValue(item, deleted));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (mediaIdKeys.has(key) && typeof item === "string" && deleted.has(item))
        continue;
      if (mediaIdLists.has(key) && Array.isArray(item)) {
        const next = item.filter(
          (id) => typeof id !== "string" || !deleted.has(id),
        );
        if (next.length) out[key] = next;
        continue;
      }
      out[key] = stripMediaValue(item, deleted);
    }
    return out;
  }
  return value;
}
export async function command(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
): Promise<string> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(Error("任务已中断"));
    const p = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "",
      err = "";
    const stop = () => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {}
    };
    const timeout = setTimeout(stop, 15 * 60 * 1000);
    signal?.addEventListener("abort", stop, { once: true });
    p.stdout.on("data", (d) => (out = (out + d).slice(-2_000_000)));
    p.stderr.on("data", (d) => (err = (err + d).slice(-5000)));
    const clean = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
    };
    p.on("error", (e) => {
      clean();
      rej(e);
    });
    p.on("close", (code) => {
      clean();
      if (signal?.aborted) rej(Error("任务已中断"));
      else if (code !== 0)
        rej(Error(`${binary} 执行失败：${err.slice(-1800)}`));
      else res(out);
    });
  });
}
export class MediaFiles {
  constructor(
    public store: Store,
    public root: string,
  ) {}
  get(id: string, projectId?: string): MediaFile {
    const f = this.store.one<MediaFile>(
      "SELECT * FROM media_files WHERE id=?",
      id,
    );
    if (!f || (projectId && f.projectId !== projectId))
      throw Error("素材不存在或不属于当前项目");
    return f;
  }
  async add(
    projectId: string,
    taskId: string,
    revision: number,
    name: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<MediaFile> {
    if (bytes.length > 256 * 1024 * 1024 || bytes.length === 0)
      throw Error("素材为空或超过 256 MB");
    let kind = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : mime.startsWith("video/")
          ? "video"
          : "document";
    const hash = createHash("sha256").update(bytes).digest("hex");
    const ext =
      kind === "image"
        ? ".png"
        : kind === "video"
          ? ".mp4"
          : kind === "audio"
            ? ".audio"
            : name.endsWith(".srt")
              ? ".srt"
              : ".json";
    const dir = join(this.root, "media");
    await mkdir(dir, { recursive: true });
    const path = join(dir, hash + ext);
    await writeFile(path, bytes);
    let metadata: any = { bytes: bytes.length, hash };
    if (kind === "image") {
      const m = await sharp(path).metadata();
      metadata = {
        ...metadata,
        width: m.width,
        height: m.height,
        format: m.format,
      };
      mime =
        m.format === "jpeg"
          ? "image/jpeg"
          : m.format === "webp"
            ? "image/webp"
            : "image/png";
    }
    if (kind === "audio" || kind === "video") {
      const m = JSON.parse(
        await command("ffprobe", [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          path,
        ]),
      );
      const v = m.streams.find((s: any) => s.codec_type === "video"),
        a = m.streams.find((s: any) => s.codec_type === "audio");
      if ((kind === "video" && !v) || (kind === "audio" && !a))
        throw Error("媒体类型与实际文件不一致");
      metadata = {
        ...metadata,
        duration: Number(m.format.duration),
        width: v?.width,
        height: v?.height,
        hasAudio: !!a,
        codec: v?.codec_name || a?.codec_name,
      };
      if (!Number.isFinite(metadata.duration) || metadata.duration <= 0)
        throw Error("媒体时长无效");
    }
    const f: MediaFile = {
      id: crypto.randomUUID(),
      projectId,
      taskId,
      revision,
      name,
      path,
      mime,
      kind,
      metadata: JSON.stringify(metadata),
      createdAt: new Date().toISOString(),
    };
    this.store.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", [
      f.id,
      projectId,
      taskId,
      revision,
      kind,
      name,
      path,
      mime,
      f.metadata,
      f.createdAt,
    ]);
    return f;
  }
  async removeMany(projectId: string, ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) throw Error("请选择要删除的素材");
    if (
      this.store.one(
        "SELECT id FROM tasks WHERE projectId=? AND status IN ('running','reviewing','coordinating')",
        projectId,
      )
    )
      throw Error("任务正在执行，请先中断再删除素材");
    const rows = unique.map((id) => this.get(id, projectId));
    const deleted = new Set(unique);
    const staleJobs = this.store
      .list<{ id: string; inputs: string }>(
        "SELECT id, inputs FROM media_jobs WHERE projectId=? AND status NOT IN ('completed','failed','cancelled')",
        projectId,
      )
      .filter((job) =>
        (JSON.parse(job.inputs) as string[]).some((id) => deleted.has(id)),
      );
    const artifacts = this.store.list<{
      id: string; content: string; status: string; stage: number;
    }>(`SELECT a.id, a.content, a.status, t.stage
        FROM artifacts a JOIN tasks t ON t.id=a.taskId WHERE t.projectId=?`, projectId);
    const disposable: string[] = [];
    const artifactUpdates: { id: string; content: string }[] = [];
    for (const artifact of artifacts) {
      const refs = referencedMediaIds(artifact.content);
      if (!refs.some((id) => deleted.has(id))) continue;
      const remaining = refs.filter((id) => !deleted.has(id));
      if (
        (artifact.status === "candidate" || artifact.status === "rejected") &&
        artifact.stage === 3 &&
        remaining.length === 0
      )
        disposable.push(artifact.id);
      else
        artifactUpdates.push({
          id: artifact.id,
          content: stripReferencedMedia(artifact.content, deleted),
        });
    }
    const libraryUpdates: { sql: string; args: any[] }[] = [];
    for (const entry of this.store.list<{ id: string; data: string }>(
      "SELECT id, data FROM asset_library WHERE projectId=?",
      projectId,
    )) {
      if (!referencedMediaIds(entry.data).some((id) => deleted.has(id))) continue;
      libraryUpdates.push({
        sql: "UPDATE asset_library SET data=? WHERE id=?",
        args: [stripReferencedMedia(entry.data, deleted), entry.id],
      });
    }
    for (const entry of this.store.list<{
      character: string; connectionId: string; data: string;
    }>("SELECT character, connectionId, data FROM voice_library WHERE projectId=?", projectId)) {
      if (!referencedMediaIds(entry.data).some((id) => deleted.has(id))) continue;
      libraryUpdates.push({
        sql: "UPDATE voice_library SET data=? WHERE projectId=? AND character=? AND connectionId=?",
        args: [
          stripReferencedMedia(entry.data, deleted),
          projectId,
          entry.character,
          entry.connectionId,
        ],
      });
    }
    this.store.db.transaction(() => {
      for (const id of disposable)
        this.store.db.run("DELETE FROM artifacts WHERE id=?", [id]);
      for (const update of artifactUpdates)
        this.store.db.run("UPDATE artifacts SET content=? WHERE id=?", [
          update.content,
          update.id,
        ]);
      for (const update of libraryUpdates)
        this.store.db.run(update.sql, update.args);
      const now = new Date().toISOString();
      for (const job of staleJobs)
        this.store.db.run(
          "UPDATE media_jobs SET status='failed', inputs='[]', remoteId='', error='输入素材已删除', updatedAt=? WHERE id=?",
          [now, job.id],
        );
      for (const row of rows) {
        this.store.db.run(
          "UPDATE media_jobs SET status='failed', outputId='', remoteId='', error='输出素材已删除', updatedAt=? WHERE outputId=?",
          [now, row.id],
        );
        this.store.db.run("DELETE FROM media_files WHERE id=?", [row.id]);
      }
    })();
    for (const row of rows) {
      const shared = this.store.one("SELECT id FROM media_files WHERE path=?", row.path);
      if (!shared) await unlink(row.path).catch(() => {});
    }
    this.store.event(
      projectId,
      "",
      "media.deleted",
      `已删除 ${unique.length} 个素材。`,
    );
  }
  async dataUrl(id: string, projectId: string) {
    const f = this.get(id, projectId);
    return `data:${f.mime};base64,${(await readFile(f.path)).toString("base64")}`;
  }
  async nativeAudio(
    fileId: string,
    signal: AbortSignal,
    preserveQuality = false,
  ) {
    const f = this.get(fileId);
    if (!JSON.parse(f.metadata).hasAudio)
      throw Error("原生音画视频没有音轨，请调整生成要求或改用独立配音");
    const dir = join(this.root, "frames", fileId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, preserveQuality ? "source.wav" : "native.wav");
    await command(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        f.path,
        "-vn",
        "-ac",
        preserveQuality ? "2" : "1",
        "-ar",
        preserveQuality ? "48000" : "16000",
        path,
      ],
      signal,
    );
    return this.add(
      f.projectId,
      f.taskId,
      f.revision,
      preserveQuality ? "视频同步音效与音乐.wav" : "原生对白审核.wav",
      await readFile(path),
      "audio/wav",
    );
  }
  async inspectFrames(fileId: string, signal?: AbortSignal) {
    const f = this.get(fileId);
    if (f.kind === "image") return [f.path];
    if (f.kind !== "video") return [];
    const metadata = JSON.parse(f.metadata),
      dir = join(this.root, "frames", fileId);
    await mkdir(dir, { recursive: true });
    const files: string[] = [];
    for (const [i, ratio] of [0, 0.2, 0.4, 0.6, 0.8, 0.98].entries()) {
      const path = join(dir, `${i}.jpg`);
      await command(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-ss",
          String(metadata.duration * ratio),
          "-i",
          f.path,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          "-pix_fmt",
          "yuvj420p",
          path,
        ],
        signal,
      );
      files.push(path);
    }
    return files;
  }
  async tailFrame(fileId: string, usedDuration: number, signal: AbortSignal) {
    const file = this.get(fileId),
      metadata = JSON.parse(file.metadata);
    if (file.kind !== "video" || usedDuration > metadata.duration + 0.05)
      throw Error("接续片段长度不足，不能提取计划末帧");
    const dir = join(this.root, "frames", fileId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `tail-${usedDuration}.png`);
    await command(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-ss",
        String(Math.max(0, usedDuration - 1 / 24)),
        "-i",
        file.path,
        "-frames:v",
        "1",
        path,
      ],
      signal,
    );
    return this.add(
      file.projectId,
      file.taskId,
      file.revision,
      `接续末帧-${fileId}.png`,
      await readFile(path),
      "image/png",
    );
  }
  async render(
    projectId: string,
    taskId: string,
    revision: number,
    timeline: Timeline,
    preview: boolean,
    signal: AbortSignal,
  ) {
    const issues = durationIssues(
      timeline.shots.reduce((sum, s) => sum + s.duration, 0),
      this.store.productionRules(projectId),
      "输出时间线",
    );
    if (issues.length) throw Error(issues.join("；"));
    const p = this.store.project(projectId),
      [w, h] = p.aspect.split(":").map(Number),
      ratio = w / h;
    if (ratio < 0.1 || ratio > 10)
      throw Error("画幅过于极端，请使用 1:10 到 10:1 之间的比例");
    const height = ratio >= 1 ? 720 : 1280,
      width = Math.round((height * ratio) / 2) * 2;
    if (width > 4096) throw Error("输出宽度超过 4096，请调整画幅");
    const dir = join(this.root, "renders", crypto.randomUUID());
    await mkdir(dir, { recursive: true });
    const segments: string[] = [],
      srt: string[] = [];
    let offset = 0;
    for (const [i, shot] of timeline.shots.entries()) {
      if (signal.aborted) throw Error("任务已中断");
      const visual = this.get(
        (preview ? shot.imageId : shot.videoId) || shot.imageId || "",
        projectId,
      );
      if (!preview && visual.kind !== "video")
        throw Error(`镜头 ${shot.title} 缺少正式视频，不能用静帧冒充视频成片`);
      const audio = shot.audioId ? this.get(shot.audioId, projectId) : null;
      const sourceAudio =
        !preview && audio && shot.sourceAudioId
          ? this.get(shot.sourceAudioId, projectId)
          : null;
      const vmeta = JSON.parse(visual.metadata),
        ameta = audio ? JSON.parse(audio.metadata) : null;
      const duration = shot.duration;
      if (!preview && shot.trimStart + duration > vmeta.duration + 0.12)
        throw Error(`镜头 ${shot.title} 的裁切范围超过视频长度`);
      if (ameta && ameta.duration > duration + 0.12)
        throw Error(`镜头 ${shot.title} 的配音长于镜头，请延长视频或修改台词`);
      const args = ["-y", "-v", "error"];
      if (visual.kind === "image") args.push("-loop", "1");
      else args.push("-ss", String(shot.trimStart));
      args.push("-i", visual.path);
      if (audio) args.push("-i", audio.path);
      else if (!vmeta.hasAudio)
        args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      if (sourceAudio)
        args.push("-ss", String(shot.trimStart), "-i", sourceAudio.path);
      const hasAudio = !!audio || !vmeta.hasAudio,
        audioIndex = hasAudio ? 1 : 0;
      const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24`;
      const subtitle = timeline.subtitles && shot.dialogue;
      let filter = `[0:v]${scale}[base];`;
      if (subtitle) {
        const subtitlePath = join(dir, `subtitle-${i}.png`);
        const lines = wrap(
          shot.dialogue,
          Math.max(8, Math.floor(width / (timeline.subtitleSize * 1.1))),
        );
        const font = timeline.subtitleSize;
        const boxH = Math.min(height, lines.length * (font + 9) + 34);
        const text = lines
          .map(
            (line, n) =>
              `<text x="50%" y="${height - boxH + font + 16 + n * (font + 9)}" text-anchor="middle" font-family="PingFang SC,Noto Sans CJK SC,sans-serif" font-size="${font}" fill="white">${escapeXml(line)}</text>`,
          )
          .join("");
        const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="${height - boxH - 20}" width="${width - 20}" height="${boxH}" rx="8" fill="black" opacity="0.55"/>${text}</svg>`;
        await sharp(Buffer.from(svg)).png().toFile(subtitlePath);
        args.push("-i", subtitlePath);
        const subtitleIndex = (hasAudio ? 2 : 1) + (sourceAudio ? 1 : 0);
        filter += `[base][${subtitleIndex}:v]overlay=0:0[v0];`;
      } else filter += "[base]null[v0];";
      filter +=
        shot.transition === "fade"
          ? `[v0]fade=t=in:d=0.2,fade=t=out:st=${Math.max(0, duration - 0.2)}:d=0.2[v];`
          : "[v0]null[v];";
      if (sourceAudio) {
        filter += `[1:a]aresample=48000,apad,atrim=duration=${duration},volume=${shot.volume}[voice];[2:a]aresample=48000,apad,atrim=duration=${duration},volume=${shot.sourceAudioVolume}[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
      } else
        filter += `[${audioIndex}:a]aresample=48000,apad,atrim=duration=${duration},volume=${shot.volume}[a]`;
      const filename = `segment-${String(i).padStart(5, "0")}.mp4`;
      args.push(
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        String(duration),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        join(dir, filename),
      );
      await command("ffmpeg", args, signal);
      segments.push(filename);
      if (shot.dialogue)
        srt.push(
          `${srt.length + 1}\n${stamp(offset)} --> ${stamp(offset + duration)}\n${shot.dialogue}\n`,
        );
      offset += duration;
      this.store.event(
        projectId,
        taskId,
        "render.progress",
        `${preview ? "动态分镜" : "成片"}合成：${i + 1}/${timeline.shots.length} 镜头完成`,
      );
    }
    await writeFile(
      join(dir, "concat.txt"),
      segments.map((s) => `file '${s}'`).join("\n"),
    );
    const joined = join(dir, "joined.mp4");
    await command(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "concat.txt",
        "-c",
        "copy",
        joined,
      ],
      signal,
      dir,
    );
    let output = joined;
    const music = timeline.musicId
        ? this.get(timeline.musicId, projectId)
        : null,
      sound = timeline.soundId ? this.get(timeline.soundId, projectId) : null;
    if (music || sound) {
      const args = ["-y", "-v", "error", "-i", joined];
      let idx = 1;
      let filters = "[0:a]asplit=2[voice][side];";
      const mixes = ["[voice]"];
      if (music) {
        args.push("-stream_loop", "-1", "-i", music.path);
        filters += `[${idx++}:a]volume=${timeline.musicVolume},atrim=duration=${offset}[music];[music][side]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duck];`;
        mixes.push("[duck]");
      } else filters += "[side]anullsink;";
      if (sound) {
        args.push("-i", sound.path);
        filters += `[${idx}:a]volume=${timeline.soundVolume},apad,atrim=duration=${offset}[fx];`;
        mixes.push("[fx]");
      }
      filters += `${mixes.join("")}amix=inputs=${mixes.length}:duration=first:normalize=0,alimiter=limit=0.95[a]`;
      output = join(dir, "mixed.mp4");
      args.push(
        "-filter_complex",
        filters,
        "-map",
        "0:v",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-t",
        String(offset),
        "-movflags",
        "+faststart",
        output,
      );
      await command("ffmpeg", args, signal);
    }
    const movie = await this.add(
      projectId,
      taskId,
      revision,
      preview ? "动态分镜.mp4" : "成片.mp4",
      await readFile(output),
      "video/mp4",
    );
    const actualIssues = durationIssues(
      JSON.parse(movie.metadata).duration,
      this.store.productionRules(projectId),
      "实际输出",
    );
    if (actualIssues.length) throw Error(actualIssues.join("；"));
    const subtitles = await this.add(
      projectId,
      taskId,
      revision,
      "字幕.srt",
      Buffer.from(srt.join("\n") || "\n"),
      "application/x-subrip",
    );
    const dialoguePath = join(dir, "dialogue.wav"),
      mixPath = join(dir, "mix.wav");
    await command(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        joined,
        "-vn",
        "-c:a",
        "pcm_s16le",
        dialoguePath,
      ],
      signal,
    );
    await command(
      "ffmpeg",
      ["-y", "-v", "error", "-i", output, "-vn", "-c:a", "pcm_s16le", mixPath],
      signal,
    );
    const dialogue = await this.add(
      projectId,
      taskId,
      revision,
      "对白轨.wav",
      await readFile(dialoguePath),
      "audio/wav",
    );
    const mix = await this.add(
      projectId,
      taskId,
      revision,
      "混音轨.wav",
      await readFile(mixPath),
      "audio/wav",
    );
    return {
      exportId: movie.id,
      subtitleId: subtitles.id,
      dialogueTrackId: dialogue.id,
      mixedTrackId: mix.id,
    };
  }
  async stitch(
    projectId: string,
    taskId: string,
    revision: number,
    clips: { id: string; duration: number }[],
    signal: AbortSignal,
  ) {
    const dir = join(this.root, "renders", crypto.randomUUID());
    await mkdir(dir, { recursive: true });
    const names = [];
    for (const [i, clip] of clips.entries()) {
      const file = this.get(clip.id, projectId),
        name = `clip-${i}.mp4`;
      await command(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-i",
          file.path,
          ...(JSON.parse(file.metadata).hasAudio
            ? []
            : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
          "-t",
          String(clip.duration),
          "-map",
          "0:v:0",
          "-map",
          JSON.parse(file.metadata).hasAudio ? "0:a:0" : "1:a:0",
          "-af",
          "aresample=48000,aformat=channel_layouts=stereo,apad",
          "-c:a",
          "aac",
          "-vf",
          "fps=24,setsar=1",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "veryfast",
          join(dir, name),
        ],
        signal,
      );
      names.push(name);
    }
    await writeFile(
      join(dir, "concat.txt"),
      names.map((n) => `file '${n}'`).join("\n"),
    );
    const path = join(dir, "joined.mp4");
    await command(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "concat.txt",
        "-c",
        "copy",
        path,
      ],
      signal,
      dir,
    );
    return (
      await this.add(
        projectId,
        taskId,
        revision,
        "长镜头拼接.mp4",
        await readFile(path),
        "video/mp4",
      )
    ).id;
  }
}
function escapeXml(s: string) {
  return s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
}
function wrap(s: string, n: number) {
  const words = Array.from(s.replace(/\s+/g, " ")),
    lines: string[] = [];
  for (let i = 0; i < words.length; i += n)
    lines.push(words.slice(i, i + n).join(""));
  return lines;
}
function stamp(t: number) {
  const ms = Math.round(t * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

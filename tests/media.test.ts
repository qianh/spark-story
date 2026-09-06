import { seedSeries, approveFixture, scriptFixture } from "./fixtures/series";
import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Store } from "../apps/server/store";
import { Runtime } from "../apps/server/runtime";
import { MediaService } from "../apps/server/media-service";
import { MediaFiles, command } from "../apps/server/media-files";
import { loadCredentials, saveCredential } from "../apps/server/credentials";
import { timelineSchema, type MediaJob } from "../packages/media";
import { timingFixture } from "./fixtures/timing";
import type { Connection, Task, Artifact } from "../packages/domain";
const resources: {
  root: string;
  store: Store;
  server: ReturnType<typeof Bun.serve>;
  runtime?: Runtime;
}[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-media-test-"));
  const store = new Store(":memory:");
  loadCredentials(root);
  const project = store.createProject({
    name: "媒体链路测试",
    source: "雨中问候",
    inputType: "idea",
    aspect: "16:9",
    template: "fresh",
    budget: 10000,
    production: { minSeconds: 1, maxSeconds: 2, narrative: "reward" },
  });
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "#81a883" },
  })
    .png()
    .toBuffer();
  await command("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.6",
    "-c:a",
    "libmp3lame",
    join(root, "voice.mp3"),
  ]);
  await command("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x180:r=24:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "clip.mp4"),
  ]);
  const audio = await readFile(join(root, "voice.mp3")),
    video = await readFile(join(root, "clip.mp4"));
  let submissions = 0,
    polls = 0;
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (path === "/generate") {
        submissions++;
        const data = (await req.json()) as any;
        if (["video", "lipsync"].includes(data.kind))
          return Response.json({ job_id: "job-" + submissions });
        return new Response(data.kind === "image" ? image : audio, {
          headers: {
            "content-type": data.kind === "image" ? "image/png" : "audio/mpeg",
          },
        });
      }
      if (path.startsWith("/jobs/")) {
        polls++;
        return Response.json({
          status: "completed",
          url: `http://127.0.0.1:${server.port}/clip.mp4`,
        });
      }
      if (path === "/clip.mp4")
        return new Response(video, {
          headers: { "content-type": "video/mp4" },
        });
      if (path === "/transcribe") return Response.json({ text: "你好" });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const c: Connection = {
    id: crypto.randomUUID(),
    name: "协议测试网关",
    transport: "api",
    provider: "media-gateway",
    model: "fixture",
    baseUrl: `http://127.0.0.1:${server.port}`,
    executable: "",
    keyEnv: "TEST_MEDIA",
    reserveCents: 5,
    health: "key_present",
    version: "test",
  };
  store.saveConnection(c);
  saveCredential(c.id, "test-key");
  for (const role of ["图片模型", "视频模型", "语音模型", "其他", "其他:口型"])
    store.db.run("INSERT INTO bindings VALUES(?,?)", [role, c.id]);
  const resource = { root, store, server } as (typeof resources)[number];
  resources.push(resource);
  return {
    root,
    store,
    project,
    c,
    image,
    audio,
    video,
    resource,
    counts: () => ({ submissions, polls }),
  };
}
afterEach(async () => {
  for (const r of resources.splice(0)) {
    r.runtime?.shutdown();
    r.server.stop(true);
    r.store.db.close();
    await rm(r.root, { recursive: true, force: true });
  }
});
test("重启保留媒体检查点和未知提交，防止重发", async () => {
  const f = await fixture(),
    media = new MediaService(f.store, f.root),
    t = f.store.one<Task>("SELECT * FROM tasks WHERE stage=3")!;
  f.store.updateTask(t.id, 1, "running");
  const content = JSON.stringify({
    type: "assets",
    data: { summary: "检查点", assets: [], voices: [] },
  });
  f.store.publish(t.id, 1, content);
  const job = media.create(t.id, 1, "image", "待下载定妆", [], {});
  media.update(job.id, { status: "submitting" });
  f.store.recover();
  expect(media.job(job.id).status).toBe("unknown");
  expect(f.store.task(t.id).revision).toBe(2);
  expect(
    f.store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=2",
      t.id,
    )?.content,
  ).toBe(content);
  expect(media.create(t.id, 2, "image", "待下载定妆", [], {}).id).toBe(job.id);
  await expect(media.run(job.id)).rejects.toThrow("未知");
  expect(f.counts().submissions).toBe(0);
});
test("图像真实保存、视频异步查询、完成结果复用不重复收费", async () => {
  const f = await fixture(),
    media = new MediaService(f.store, f.root),
    t = f.store.one<Task>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=3",
      f.project.id,
    )!;
  const signal = new AbortController().signal;
  const imageId = await media.ensure(t.id, 1, "image", "定妆", [], {}, signal);
  expect(media.files.get(imageId).kind).toBe("image");
  const first = await media.ensure(
    t.id,
    1,
    "video",
    "动作",
    [imageId],
    { duration: 1 },
    signal,
  );
  const second = await media.ensure(
    t.id,
    1,
    "video",
    "动作",
    [imageId],
    { duration: 1 },
    signal,
  );
  expect(first).toBe(second);
  expect(f.counts()).toEqual({ submissions: 2, polls: 1 });
  const jobs = f.store.list<MediaJob>("SELECT * FROM media_jobs");
  expect(jobs.every((j) => j.status === "completed")).toBe(true);
  expect(jobs.find((j) => j.kind === "video")?.remoteId).toBeTruthy();
}, 20000);
test("中断后的外部视频只查询原任务，不重复提交", async () => {
  const f = await fixture(),
    media = new MediaService(f.store, f.root),
    t = f.store.one<Task>("SELECT * FROM tasks WHERE stage=5")!;
  const job = media.create(t.id, 1, "video", "场景", [], {});
  media.update(job.id, { status: "detached", remoteId: "already-submitted" });
  f.store.db.run("UPDATE tasks SET revision=2 WHERE id=?", [t.id]);
  expect(media.create(t.id, 2, "video", "场景", [], {}).id).toBe(job.id);
  const result = await media.run(job.id);
  expect(media.files.get(result).kind).toBe("video");
  expect(f.counts()).toEqual({ submissions: 0, polls: 1 });
}, 20000);
test("未知提交不能自动重发；预算不足不能发出媒体请求", async () => {
  const f = await fixture(),
    media = new MediaService(f.store, f.root),
    t = f.store.one<Task>("SELECT * FROM tasks WHERE stage=3")!;
  const job = media.create(t.id, 1, "image", "定妆", [], {});
  media.update(job.id, { status: "unknown" });
  expect(media.run(job.id)).rejects.toThrow("未知");
  f.store.db.run("UPDATE tasks SET revision=2 WHERE id=?", [t.id]);
  expect(media.create(t.id, 2, "image", "定妆", [], {}).id).toBe(job.id);
  f.store.db.run("UPDATE projects SET budget=0");
  const other = media.create(t.id, 2, "image", "其他图片", [], {});
  await expect(media.run(other.id)).rejects.toThrow("预算");
  expect(f.counts().submissions).toBe(0);
}, 20000);
test("末帧来自实际已用视频段，长度不足拒绝接续；超限时间线不能导出", async () => {
  const f = await fixture(),
    files = new MediaFiles(f.store, f.root),
    task = f.store.one<Task>("SELECT * FROM tasks WHERE stage=5")!;
  const video = await files.add(
    f.project.id,
    task.id,
    1,
    "尾帧测试.mp4",
    f.video,
    "video/mp4",
  );
  const frame = await files.tailFrame(
    video.id,
    1,
    new AbortController().signal,
  );
  expect(frame.kind).toBe("image");
  expect(JSON.parse(frame.metadata).width).toBe(320);
  await expect(
    files.tailFrame(video.id, 3, new AbortController().signal),
  ).rejects.toThrow("长度不足");
  await expect(
    files.render(
      f.project.id,
      task.id,
      1,
      timelineSchema.parse({
        shots: [
          {
            id: "s",
            title: "超限",
            prompt: "画面",
            duration: 3,
            videoId: video.id,
          },
        ],
      }),
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow("1～2");
});
test("定妆→动态分镜→视频→音乐字幕成片完整流程，产物由真实 FFmpeg 合成", async () => {
  const f = await fixture();
  const cli: Connection = {
    ...f.c,
    id: "test-text",
    transport: "cli",
    provider: "claude",
    executable: "/fixture/claude",
  };
  f.store.saveConnection(cli);
  for (const role of ["主模型", "文本模型"])
    f.store.db.run("INSERT INTO bindings VALUES(?,?)", [role, cli.id]);
  const generator = async (_c: Connection, prompt: string) => {
    if (prompt.startsWith("你是角色与资产 Agent"))
      return JSON.stringify({
        summary: "定妆方案",
        assets: [
          {
            id: "hero",
            name: "主角",
            kind: "character",
            prompt: "绿色外套的动漫角色",
            libraryId: f.store.assetLibrary(f.project.id)[0]?.libraryId,
          },
        ],
        voices: [{ character: "主角", voice: "alloy", sampleText: "你好" }],
      });
    if (prompt.startsWith("你是分镜 Agent"))
      return JSON.stringify({
        summary: "分镜计划",
        shots: [
          {
            id: "s1",
            title: "问候",
            prompt: "主角挥手",
            duration: 1,
            beatId: "B1",
            sceneId: "scene1",
            assetIds: ["hero"],
            dialogue: "你好",
            speaker: "主角",
            voice: "alloy",
            route: "separate",
          },
          {
            id: "s2",
            title: "回应",
            prompt: "主角点头",
            duration: 1,
            beatId: "B2",
            sceneId: "scene1",
            assetIds: ["hero"],
            dialogue: "",
            route: "separate",
          },
        ],
      });
    if (prompt.startsWith("你是后期音乐音效 Agent"))
      return JSON.stringify({
        summary: "成片",
        musicPrompt: "温暖配乐",
        soundPrompt: "轻柔环境音",
      });
    return JSON.stringify({ pass: true, feedback: "测试审核通过" });
  };
  const runtime = new Runtime(f.store, f.root, generator);
  f.resource.runtime = runtime;
  seedSeries(f.store, f.project.id);
  approveFixture(f.store, f.project.id, 2, scriptFixture(1, 2), 1);
  const shotPlan = await generator({} as Connection, "你是分镜 Agent");
  approveFixture(
    f.store,
    f.project.id,
    8,
    JSON.stringify({ type: "shot-plan", data: JSON.parse(shotPlan) }),
    1,
  );
  for (const stage of [3, 4, 5, 6]) {
    const t = f.store.one<Task>(
      "SELECT * FROM tasks WHERE stage=? AND episode=1",
      stage,
    )!;
    f.store.updateTask(t.id, t.revision, "ready");
    runtime.start(t.id, t.revision);
    for (let n = 0; n < 1500 && runtime.active.has(t.id); n++)
      await Bun.sleep(20);
    const current = f.store.task(t.id);
    expect(current.error).toBe("");
    expect(current.status).toBe("awaiting_user");
    const a = f.store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND status='reviewed' ORDER BY createdAt DESC LIMIT 1",
      t.id,
    )!;
    f.store.approve(t.id, current.revision, a.id);
  }
  const beforeReuse = f.counts().submissions;
  approveFixture(f.store, f.project.id, 2, scriptFixture(2, 2), 2);
  approveFixture(
    f.store,
    f.project.id,
    8,
    JSON.stringify({ type: "shot-plan", data: JSON.parse(shotPlan) }),
    2,
  );
  const secondAssets = f.store
    .tasks(f.project.id)
    .find((t) => t.stage === 3 && t.episode === 2)!;
  runtime.start(secondAssets.id, secondAssets.revision);
  for (let n = 0; n < 500 && runtime.active.has(secondAssets.id); n++)
    await Bun.sleep(20);
  expect(f.store.task(secondAssets.id).status).toBe("awaiting_user");
  expect(f.counts().submissions).toBe(beforeReuse);
  const reused = f.store.one<Artifact>(
    "SELECT * FROM artifacts WHERE taskId=? AND status='reviewed' ORDER BY rowid DESC LIMIT 1",
    secondAssets.id,
  )!;
  f.store.approve(secondAssets.id, secondAssets.revision, reused.id);
  expect(f.store.assetLibrary(f.project.id)).toHaveLength(1);
  const final = f.store.one<Artifact>(
    "SELECT a.* FROM artifacts a JOIN tasks t ON t.id=a.taskId WHERE t.stage=6 AND a.status='approved'",
  )!;
  const timeline = JSON.parse(final.content).data,
    files = runtime.media.files;
  const videoFile = files.get(timeline.exportId);
  expect(JSON.parse(videoFile.metadata).hasAudio).toBe(true);
  expect(JSON.parse(videoFile.metadata).duration).toBeGreaterThan(0.9);
  expect(await readFile(files.get(timeline.subtitleId).path, "utf8")).toContain(
    "你好",
  );
  expect(files.get(timeline.dialogueTrackId).kind).toBe("audio");
  expect(files.get(timeline.mixedTrackId).kind).toBe("audio");
  const count = f.counts().submissions;
  const rerender = await files.render(
    f.project.id,
    videoFile.taskId,
    videoFile.revision,
    timelineSchema.parse({ ...timeline, musicVolume: 0.1 }),
    false,
    new AbortController().signal,
  );
  expect(rerender.exportId).toBeTruthy();
  expect(f.counts().submissions).toBe(count);
}, 60000);

test("动态分镜应用用户和审核反馈，清除旧媒体引用；无反馈直接复用文字分镜", async () => {
  const f = await fixture();
  const { MediaPipeline } = await import("../apps/server/media-pipeline");
  const task = f.store.tasks(f.project.id).find((t) => t.stage === 4)!;
  const plan = {
    summary: "文字分镜",
    shots: [1, 2].map((n) => ({
      id: `s${n}`,
      title: "原镜头",
      prompt: "挥手",
      duration: 1,
      beatId: `B${n}`,
      sceneId: "scene1",
      assetIds: ["hero"],
      dialogue: "",
      route: "separate",
    })),
  };
  const upstream = [
    {
      taskId: task.id,
      content: JSON.stringify({ type: "shot-plan", data: plan }),
    },
    {
      taskId: task.id,
      content: JSON.stringify({
        type: "assets",
        data: {
          summary: "资产",
          assets: [
            {
              id: "hero",
              name: "主角",
              kind: "character",
              prompt: "主角",
              imageId: "asset-image",
            },
          ],
          voices: [],
        },
      }),
    },
  ] as Artifact[];
  const prompts: string[] = [];
  const pipeline = new MediaPipeline({
    store: f.store,
    call: async (
      _task: Task,
      _attempt: string,
      _text: Connection,
      prompt: string,
    ) => {
      prompts.push(prompt);
      return JSON.stringify({
        ...plan,
        shots: plan.shots.map((s) => ({
          ...s,
          title: "修改后镜头",
          prompt: "点头",
          imageId: "stale-image",
          audioId: "stale-audio",
          videoId: "stale-video",
        })),
      });
    },
    media: {
      connection: () => ({}),
      files: { render: async () => ({ exportId: "preview" }) },
    },
  } as unknown as Runtime);
  for (const feedback of ["", "用户要求：改为点头", "审核未通过：改为点头"]) {
    const result = await pipeline.produce(
      task,
      "test",
      f.c,
      upstream,
      feedback,
      null,
      new AbortController().signal,
      () => {},
    );
    const shots = (result.data as typeof plan).shots;
    expect(shots[0].title).toBe(feedback ? "修改后镜头" : "原镜头");
    expect(shots[0]).toMatchObject({
      imageId: "asset-image",
      draftImage: true,
    });
    expect(shots[0]).not.toHaveProperty("audioId");
    expect(shots[0]).not.toHaveProperty("videoId");
    if (feedback) {
      expect(prompts.at(-1)).toContain(feedback);
      expect(prompts.at(-1)).toContain("文字分镜");
    }
  }
  expect(prompts).toHaveLength(2);
  expect(plan.shots[0].title).toBe("原镜头");
});

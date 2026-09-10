import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Store } from "../apps/server/store";
import { MediaFiles, referencedMediaIds } from "../apps/server/media-files";

test("批量删除素材；定妆候选只引用这些文件时丢掉本版候选", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lib-del-"));
  try {
    const store = new Store(":memory:");
    const project = store.createProject({
      name: "删素材",
      source: "山门",
      inputType: "idea",
      aspect: "9:16",
      template: "donghua3d",
      budget: 0,
    });
    const look = store.one<{ id: string; revision: number }>(
      "SELECT id, revision FROM tasks WHERE projectId=? AND stage=3",
      project.id,
    )!;
    const files = new MediaFiles(store, root);
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#334455" },
    })
      .png()
      .toBuffer();
    const img = await files.add(
      project.id,
      look.id,
      look.revision,
      "山门.png",
      png,
      "image/png",
    );
    const published = store.publish(
      look.id,
      look.revision,
      JSON.stringify({
        type: "assets",
        data: {
          summary: "定妆",
          assets: [
            {
              id: "LOC-GATE",
              name: "山门",
              kind: "scene",
              prompt: "山门",
              imageId: img.id,
            },
          ],
          voices: [],
        },
      }),
    );
    expect(published.status).toBe("candidate");
    expect(published.content).toContain(img.id);
    expect(referencedMediaIds(published.content)).toEqual([img.id]);
    await files.removeMany(project.id, [img.id]);
    expect(store.one("SELECT id FROM media_files WHERE id=?", img.id)).toBeNull();
    expect(
      store.one(
        "SELECT id FROM artifacts WHERE taskId=? AND revision=?",
        look.id,
        look.revision,
      ),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("删除被中断媒体任务当作参考的素材，文件去掉并结束该任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lib-job-ref-"));
  try {
    const store = new Store(":memory:");
    const project = store.createProject({
      name: "参考残留",
      source: "山门",
      inputType: "idea",
      aspect: "9:16",
      template: "donghua3d",
      budget: 0,
    });
    const look = store.one<{ id: string; revision: number }>(
      "SELECT id, revision FROM tasks WHERE projectId=? AND stage=3",
      project.id,
    )!;
    const files = new MediaFiles(store, root);
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#334455" },
    })
      .png()
      .toBuffer();
    const img = await files.add(
      project.id,
      look.id,
      look.revision,
      "沈不言.png",
      png,
      "image/png",
    );
    store.db.run("INSERT INTO media_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
      "zombie-job",
      project.id,
      look.id,
      look.revision,
      "image",
      "角色与关键帧 Agent",
      "后续定妆",
      JSON.stringify([img.id]),
      "{}",
      "{}",
      "unknown",
      "",
      "",
      "后台重启；保留提交记录，未自动重发",
      "",
      "op",
      "now",
      "now",
    ]);
    await files.removeMany(project.id, [img.id]);
    expect(store.one("SELECT id FROM media_files WHERE id=?", img.id)).toBeNull();
    const job = store.one<{ status: string; error: string; inputs: string }>(
      "SELECT status, error, inputs FROM media_jobs WHERE id=?",
      "zombie-job",
    )!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("输入素材");
    expect(JSON.parse(job.inputs)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("任务执行中不能批量删除素材", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lib-busy-"));
  try {
    const store = new Store(":memory:");
    const project = store.createProject({
      name: "忙",
      source: "山门",
      inputType: "idea",
      aspect: "9:16",
      template: "donghua3d",
      budget: 0,
    });
    const look = store.one<{ id: string; revision: number }>(
      "SELECT id, revision FROM tasks WHERE projectId=? AND stage=3",
      project.id,
    )!;
    store.db.run("UPDATE tasks SET status='running' WHERE id=?", [look.id]);
    const files = new MediaFiles(store, root);
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#334455" },
    })
      .png()
      .toBuffer();
    const img = await files.add(
      project.id,
      look.id,
      look.revision,
      "山门.png",
      png,
      "image/png",
    );
    await expect(files.removeMany(project.id, [img.id])).rejects.toThrow("执行");
    expect(
      store.one<{ id: string }>("SELECT id FROM media_files WHERE id=?", img.id)
        ?.id,
    ).toBe(img.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const source of ["approved", "partial", "old", "downstream", "asset_library", "voice_library", "sourceAudioId", "subtitleId"]) {
  test(`删除仍被 ${source} 引用的素材，文件去掉并解除引用`, async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-reference-"));
    const store = new Store(":memory:");
    try {
      const project = store.createProject({ name: "引用保护", source: "山门", inputType: "idea", aspect: "9:16", template: "donghua3d", budget: 0 });
      const task = store.one<{ id: string; revision: number }>("SELECT id, revision FROM tasks WHERE projectId=? AND stage=3", project.id)!;
      const files = new MediaFiles(store, root);
      const a = await files.add(project.id, task.id, 1, "a.json", Buffer.from("a"), "application/json");
      const b = await files.add(project.id, task.id, 1, "b.json", Buffer.from("b"), "application/json");
      const content = JSON.stringify({ [source === "sourceAudioId" || source === "subtitleId" ? source : "imageId"]: a.id, ...(source === "partial" ? { candidates: ["retained"] } : {}) });
      let artifactId = "";
      if (source === "asset_library")
        store.db.run("INSERT INTO asset_library VALUES(?,?,?,?,?,?,?,?)", ["library", project.id, "asset", 1, task.id, 1, content, "now"]);
      else if (source === "voice_library")
        store.db.run("INSERT INTO voice_library VALUES(?,?,?,?)", [project.id, "role", "connection", JSON.stringify({ audioId: a.id })]);
      else {
        const artifact = store.publish(task.id, 1, content);
        artifactId = artifact.id;
        if (source === "approved" || source === "sourceAudioId" || source === "subtitleId") store.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [artifact.id]);
        if (source === "old") store.db.run("UPDATE tasks SET revision=2 WHERE id=?", [task.id]);
        if (source === "downstream") store.db.run("UPDATE artifacts SET taskId=(SELECT id FROM tasks WHERE projectId=? AND stage=4 LIMIT 1) WHERE id=?", [project.id, artifact.id]);
      }
      await files.removeMany(project.id, [b.id, a.id]);
      expect(store.one("SELECT id FROM media_files WHERE id=?", a.id)).toBeNull();
      expect(store.one("SELECT id FROM media_files WHERE id=?", b.id)).toBeNull();
      expect(await Bun.file(a.path).exists()).toBe(false);
      expect(await Bun.file(b.path).exists()).toBe(false);
      if (source === "old") {
        expect(store.one("SELECT id FROM artifacts WHERE id=?", artifactId)).toBeNull();
      } else if (source === "asset_library") {
        const row = store.one<{ data: string }>("SELECT data FROM asset_library WHERE projectId=?", project.id)!;
        expect(referencedMediaIds(row.data)).toEqual([]);
      } else if (source === "voice_library") {
        const row = store.one<{ data: string }>("SELECT data FROM voice_library WHERE projectId=?", project.id)!;
        expect(referencedMediaIds(row.data)).toEqual([]);
      } else {
        const art = store.one<{ content: string; status: string }>("SELECT * FROM artifacts WHERE id=?", artifactId)!;
        expect(referencedMediaIds(art.content)).toEqual(source === "partial" ? ["retained"] : []);
        if (source === "partial") expect(JSON.parse(art.content).candidates).toEqual(["retained"]);
        if (source === "approved" || source === "sourceAudioId" || source === "subtitleId") expect(art.status).toBe("approved");
      }
    } finally {
      store.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("批量删除定妆候选产物，媒体文件仍保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-art-del-"));
  const store = new Store(":memory:");
  try {
    const project = store.createProject({
      name: "删产物",
      source: "山门",
      inputType: "idea",
      aspect: "9:16",
      template: "donghua3d",
      budget: 0,
    });
    const look = store.one<{ id: string; revision: number }>(
      "SELECT id, revision FROM tasks WHERE projectId=? AND stage=3",
      project.id,
    )!;
    const files = new MediaFiles(store, root);
    const img = await files.add(
      project.id,
      look.id,
      look.revision,
      "山门.png",
      Buffer.from("img"),
      "application/json",
    );
    const published = store.publish(
      look.id,
      look.revision,
      JSON.stringify({ type: "assets", data: { summary: "定妆", assets: [{ id: "LOC-GATE", name: "山门", kind: "scene", prompt: "山门", imageId: img.id }], voices: [] } }),
    );
    store.removeArtifacts(project.id, [published.id]);
    expect(store.one("SELECT id FROM artifacts WHERE id=?", published.id)).toBeNull();
    expect(files.get(img.id).id).toBe(img.id);
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("任务执行中不能删除该任务产物", async () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({
      name: "忙产物",
      source: "山门",
      inputType: "idea",
      aspect: "9:16",
      template: "donghua3d",
      budget: 0,
    });
    const look = store.one<{ id: string }>(
      "SELECT id FROM tasks WHERE projectId=? AND stage=3",
      project.id,
    )!;
    const published = store.publish(look.id, 1, JSON.stringify({ summary: "定妆" }));
    store.db.run("UPDATE tasks SET status='running' WHERE id=?", [look.id]);
    expect(() => store.removeArtifacts(project.id, [published.id])).toThrow("执行");
    expect(store.one<{ id: string }>("SELECT id FROM artifacts WHERE id=?", published.id)?.id).toBe(published.id);
  } finally {
    store.db.close();
  }
});

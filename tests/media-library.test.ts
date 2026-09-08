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
  test(`拒绝删除仍被 ${source} 引用的素材，整批保持不变`, async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-reference-"));
    const store = new Store(":memory:");
    try {
      const project = store.createProject({ name: "引用保护", source: "山门", inputType: "idea", aspect: "9:16", template: "donghua3d", budget: 0 });
      const task = store.one<{ id: string; revision: number }>("SELECT id, revision FROM tasks WHERE projectId=? AND stage=3", project.id)!;
      const files = new MediaFiles(store, root);
      const a = await files.add(project.id, task.id, 1, "a.json", Buffer.from("a"), "application/json");
      const b = await files.add(project.id, task.id, 1, "b.json", Buffer.from("b"), "application/json");
      const content = JSON.stringify({ [source === "sourceAudioId" || source === "subtitleId" ? source : "imageId"]: a.id, ...(source === "partial" ? { candidates: ["retained"] } : {}) });
      if (source === "asset_library")
        store.db.run("INSERT INTO asset_library VALUES(?,?,?,?,?,?,?,?)", ["library", project.id, "asset", 1, task.id, 1, content, "now"]);
      else if (source === "voice_library")
        store.db.run("INSERT INTO voice_library VALUES(?,?,?,?)", [project.id, "role", "connection", JSON.stringify({ audioId: a.id })]);
      else {
        const artifact = store.publish(task.id, 1, content);
        if (source === "approved" || source === "sourceAudioId" || source === "subtitleId") store.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [artifact.id]);
        if (source === "old") store.db.run("UPDATE tasks SET revision=2 WHERE id=?", [task.id]);
        if (source === "downstream") store.db.run("UPDATE artifacts SET taskId=(SELECT id FROM tasks WHERE projectId=? AND stage=4 LIMIT 1) WHERE id=?", [project.id, artifact.id]);
      }
      await expect(files.removeMany(project.id, [b.id, a.id])).rejects.toThrow("引用");
      expect(files.get(a.id).id).toBe(a.id);
      expect(files.get(b.id).id).toBe(b.id);
      expect(await Bun.file(a.path).exists()).toBe(true);
      expect(await Bun.file(b.path).exists()).toBe(true);
    } finally {
      store.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

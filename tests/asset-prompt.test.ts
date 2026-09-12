import { expect, test } from "bun:test";
import { Store } from "../apps/server/store";
import { Runtime } from "../apps/server/runtime";
import { assetPlanSchema } from "../packages/media";
import { visualStyleKey } from "../packages/visual-style";
import type { Connection } from "../packages/domain";

function setup() {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "提示词草稿", source: "仙侠", inputType: "idea", aspect: "16:9", template: "ink", budget: 0 });
  const runtime = new Runtime(store, "/tmp/spark-prompt-tests");
  store.binding = () => ({} as Connection);
  runtime.call = async () => JSON.stringify({ prompt: "青色玉牌，云纹，细长轮廓", promptFormat: "visual-description-v1" });
  const task = store.tasks(project.id).find(t => t.stage === 3)!;
  const assets = assetPlanSchema.parse({ summary: "全剧", assets: [
    { id: "a", kind: "prop", name: "玉牌", prompt: "白色玉牌", promptFormat: "visual-description-v1", imageId: "old", generationPrompt: "old compiled", generationStyleKey: visualStyleKey(store.visualStyle(project.id)), candidates: ["old"], candidateSpecs: { old: { prompt: "old compiled", styleKey: visualStyleKey(store.visualStyle(project.id)), styleVersion: "old", referenceIds: [] } } },
    { id: "b", kind: "scene", name: "山门", prompt: "山门" },
  ] });
  store.publish(task.id, task.revision, JSON.stringify({ type: "assets", data: assets }));
  const latest = () => JSON.parse(store.one<{content: string}>("SELECT content FROM artifacts WHERE taskId=? ORDER BY rowid DESC LIMIT 1", task.id)!.content);
  return { store, project, task, runtime, assets, latest };
}

test("single asset prompt regeneration preserves images and other assets; retry uses draft and selection commits content", async () => {
  const f = setup();
  try {
    let request = "";
    f.runtime.call = async (_task, _attempt, _connection, prompt) => {
      request = prompt;
      return JSON.stringify({ prompt: "青色玉牌，云纹，细长轮廓", promptFormat: "visual-description-v1" });
    };
    const updated = await f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a", "改成青色");
    const a = updated.data.assets[0];
    expect(request).toContain(f.store.visualStyle(f.project.id).prompt);
    expect(request).toContain("改成青色");
    expect(a.promptDraft?.generationPrompt).toContain("青色玉牌");
    expect(a.prompt).toBe("白色玉牌");
    expect(a.generationPrompt).toBe("old compiled");
    expect(a.candidateSpecs).toEqual(f.assets.assets[0].candidateSpecs);
    expect(updated.data.assets[1]).toEqual(f.assets.assets[1]);
    let generated = "";
    f.runtime.media.ensure = async (_id, _revision, _kind, prompt) => { generated = prompt; return "new"; };
    f.runtime.media.files.get = (() => ({ path: "test.png" })) as any;
    const retry = await f.runtime.retryAsset(f.task.id, f.task.revision, "a");
    expect(generated).toBe(a.promptDraft!.generationPrompt);
    expect(retry.data.assets[0].imageId).toBe("old");
    expect(retry.data.assets[0].candidates).toEqual(["old", "new"]);
    const selected = await f.runtime.selectAsset(f.task.id, f.task.revision, "a", "new");
    expect(selected.data.assets[0].prompt).toBe(a.promptDraft!.prompt);
    expect(selected.data.assets[0].promptDraft).toBeUndefined();
    expect(selected.data.assets[0].generationPrompt).toBe(generated);
    const original = await f.runtime.selectAsset(f.task.id, f.task.revision, "a", "old");
    expect(original.data.assets[0].prompt).toBe("白色玉牌");
    expect(original.data.assets[0].generationPrompt).toBe("old compiled");
  } finally { f.store.db.close(); }
});

for (const change of ["abort", "revision", "style"] as const) test(`discard prompt result after ${change} changes`, async () => {
  const f = setup();
  try {
    const before = f.latest();
    f.runtime.call = async () => {
      if (change === "abort") f.runtime.active.get(f.task.id)!.abort();
      if (change === "revision") f.store.db.run("UPDATE tasks SET revision=revision+1 WHERE id=?", [f.task.id]);
      if (change === "style") f.store.setVisualTemplate(f.project.id, "cel");
      return JSON.stringify({ prompt: "青色玉牌", promptFormat: "visual-description-v1" });
    };
    await expect(f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a")).rejects.toThrow();
    if (change === "style") expect(f.latest().data.assets[0].promptDraft).toBeUndefined();
    else expect(f.latest()).toEqual(before);
    expect(f.runtime.active.has(f.task.id)).toBe(false);
  } finally { f.store.db.close(); }
});

test("reject concurrent regeneration, malformed responses and obsolete drafts", async () => {
  const f = setup();
  try {
    f.runtime.active.set(f.task.id, new AbortController());
    await expect(f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a")).rejects.toThrow("任务正在执行");
    f.runtime.active.clear();
    const before = f.latest();
    f.runtime.call = async () => JSON.stringify({ prompt: "" });
    await expect(f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a")).rejects.toThrow();
    expect(f.latest()).toEqual(before);
    f.runtime.call = async () => JSON.stringify({ prompt: "青色玉牌", promptFormat: "visual-description-v1" });
    await f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a");
    f.store.setVisualTemplate(f.project.id, "cel");
    await expect(f.runtime.retryAsset(f.task.id, f.task.revision, "a")).rejects.toThrow();
  } finally { f.store.db.close(); }
});

for (const status of ["reviewed", "unreviewed", "approved"] as const) test(`draft and unselected candidate preserve ${status} confirmation state`, async () => {
  const f = setup();
  try {
    f.store.patchSettings(f.project.id, { modelReviewEnabled: status === "reviewed" });
    f.store.canRun = () => true;
    const artifact = f.store.one<{ id: string; content: string; status: string }>("SELECT * FROM artifacts WHERE taskId=? ORDER BY rowid DESC LIMIT 1", f.task.id)!;
    const content = JSON.parse(artifact.content);
    content.data.assets[1].imageId = "old-b";
    for (const imageId of ["old", "old-b"])
      f.store.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", [imageId, f.project.id, f.task.id, f.task.revision, "image", imageId, "test.png", "image/png", "{}", new Date().toISOString()]);
    f.store.db.run("UPDATE artifacts SET content=?, status=? WHERE id=?", [JSON.stringify(content), status, artifact.id]);
    f.store.updateTask(f.task.id, f.task.revision, status === "approved" ? "approved" : "awaiting_user");
    if (status === "approved") f.store.registerAssets(f.task, JSON.stringify(content));
    const library = f.store.assetLibrary(f.project.id);
    const assertUnchanged = () => {
      const latest = f.store.one<{ id: string; status: string }>("SELECT * FROM artifacts WHERE taskId=? ORDER BY rowid DESC LIMIT 1", f.task.id)!;
      expect(latest.id).toBe(artifact.id);
      expect(latest.status).toBe(status);
      expect(f.store.task(f.task.id).status).toBe(status === "approved" ? "approved" : "awaiting_user");
      expect(f.store.assetLibrary(f.project.id)).toEqual(library);
    };
    await f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a", "改成青色");
    assertUnchanged();
    f.runtime.media.ensure = async () => "new";
    f.runtime.media.files.get = (() => ({ path: "test.png" })) as any;
    f.runtime.call = async () => JSON.stringify({ pass: true, feedback: "符合画风" });
    await f.runtime.retryAsset(f.task.id, f.task.revision, "a");
    assertUnchanged();
    if (status !== "approved") {
      f.store.approve(f.task.id, f.task.revision, artifact.id);
      expect(f.store.task(f.task.id).status).toBe("approved");
      expect(f.store.assetLibrary(f.project.id).find(a => a.id === "a")?.imageId).toBe("old");
    }
  } finally { f.store.db.close(); }
});

test("a concurrent edit of the same artifact is not overwritten by a prompt result", async () => {
  const f = setup();
  try {
    f.runtime.call = async () => {
      const edited = f.latest();
      edited.data.summary = "另一个编辑已保存";
      f.store.db.run("UPDATE artifacts SET content=? WHERE taskId=?", [JSON.stringify(edited), f.task.id]);
      return JSON.stringify({ prompt: "青色玉牌", promptFormat: "visual-description-v1" });
    };
    await expect(f.runtime.regenerateAssetPrompt(f.task.id, f.task.revision, "a")).rejects.toThrow("定妆产物已变化");
    expect(f.latest().data.summary).toBe("另一个编辑已保存");
    expect(f.latest().data.assets[0].promptDraft).toBeUndefined();
  } finally { f.store.db.close(); }
});

import { storyFixture, planFixture, approveFixture } from "./fixtures/series";
import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../apps/server/store";
import { timingFixture } from "./fixtures/timing";
import type { Connection } from "../packages/domain";
const stores: Store[] = [];
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  const p = s.createProject({
    name: "雨天来信",
    source: "少女在雨天看见未来",
    inputType: "idea",
    aspect: "9:16",
    template: "cel",
    budget: 100,
  });
  return {
    s,
    p,
    t: s.list<any>(
      "SELECT * FROM tasks WHERE projectId=? ORDER BY stage",
      p.id,
    )[0],
  };
}
afterEach(() => stores.splice(0).forEach((s) => s.db.close()));
const connection: Connection = {
  id: "api",
  name: "test",
  transport: "api",
  provider: "compatible",
  model: "test",
  baseUrl: "https://example.com/v1",
  keyEnv: "TEST_KEY",
  executable: "",
  reserveCents: 70,
  health: "unverified",
  version: "",
};
describe("持久任务规则", () => {
  test("项目不限制集数；下一阶段须待人工通过", () => {
    const { s, p, t } = setup();
    expect(s.list("SELECT * FROM tasks WHERE projectId=?", p.id)).toHaveLength(
      9,
    );
    const next = s.list<any>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=7",
      p.id,
    )[0];
    expect(s.canRun(next)).toBe(false);
    const a = s.publish(t.id, 1, "概要");
    s.updateTask(t.id, 1, "awaiting_user");
    expect(() => s.approve(t.id, 1, a.id)).toThrow();
    s.db.run("UPDATE artifacts SET status='reviewed' WHERE id=?", [a.id]);
    s.approve(t.id, 1, a.id);
    expect(s.canRun(s.task(next.id))).toBe(true);
    expect(s.task(next.id).status).toBe("ready");
    expect(s.task(next.id).title).toBe("完整故事稿");
    const script = s.one<any>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=2",
      p.id,
    )!;
    expect(script.title).toBe("单集剧本");
    expect(s.canRun(script)).toBe(false);
    approveFixture(s, p.id, 7, JSON.stringify(storyFixture));
    approveFixture(s, p.id, 1, JSON.stringify(planFixture));
    expect(s.canRun(s.task(script.id))).toBe(true);
  });
  test("重复领取同一任务被拒绝", () => {
    const { s, t } = setup();
    s.claim(t.id, 1, {});
    expect(() => s.claim(t.id, 1, {})).toThrow();
  });
  test("中断后的旧产物不能覆盖当前修订", () => {
    const { s, t } = setup();
    s.claim(t.id, 1, {});
    s.interrupt(t.id, 1, "换成银色头发");
    expect(s.task(t.id).revision).toBe(2);
    expect(s.publish(t.id, 1, "旧结果").status).toBe("superseded");
    expect(s.updateTask(t.id, 1, "awaiting_user")).toBe(false);
  });
  test("中断把当前定妆产物带到新修订，工作台仍能看见", () => {
    const { s, p } = setup();
    const looks = s.tasks(p.id).find((task) => task.stage === 3)!;
    const content = JSON.stringify({
      type: "assets",
      data: {
        summary: "全剧",
        assets: [{ id: "hero", name: "沈不言", kind: "character" }],
        voices: [],
      },
    });
    s.publish(looks.id, looks.revision, content);
    const oldRev = looks.revision;
    s.interrupt(looks.id, oldRev, "");
    const task = s.task(looks.id);
    expect(task.revision).toBe(oldRev + 1);
    const current = s.one<any>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? ORDER BY createdAt DESC LIMIT 1",
      looks.id,
      task.revision,
    );
    expect(current.status).toBe("candidate");
    expect(current.content).toBe(content);
    expect(s.publish(looks.id, oldRev, "旧修订覆盖").status).toBe("superseded");
    expect(
      (s.board(p.id).artifacts as any[]).some(
        (a) =>
          a.taskId === looks.id &&
          a.revision === task.revision &&
          a.content === content,
      ),
    ).toBe(true);
  });
  test("中断自己不擅自停止其他任务", () => {
    const { s, p, t } = setup();
    const next = s.list<any>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=1",
      p.id,
    )[0];
    s.updateTask(next.id, 1, "running");
    s.interrupt(t.id, 1, "修改");
    expect(s.task(next.id).status).toBe("running");
    s.invalidateAfter(s.task(t.id));
    expect(s.task(next.id).status).toBe("blocked");
  });
  test("过期审核和跨任务产物无法被批准", () => {
    const { s, t } = setup();
    const a = s.publish(t.id, 1, "旧版");
    s.db.run("UPDATE artifacts SET status='reviewed' WHERE id=?", [a.id]);
    s.interrupt(t.id, 1, "更改");
    s.updateTask(t.id, 2, "awaiting_user");
    expect(() => s.approve(t.id, 1, a.id)).toThrow();
    expect(() => s.approve(t.id, 2, a.id)).toThrow();
  });
  test("API 额度原子预留，CLI 不受预算限制", () => {
    const { s, p } = setup();
    expect(s.reserve(p.id, "one", connection)).toBeTruthy();
    expect(() => s.reserve(p.id, "two", connection)).toThrow("预算");
    expect(
      s.reserve(p.id, "cli", { ...connection, transport: "cli" }),
    ).toBeNull();
    expect(s.one<any>("SELECT COUNT(*) n FROM costs")!.n).toBe(1);
  });
  test("切换画风只重做定妆及之后画面，剧本保留；执行中拒绝", () => {
    const { s, p } = setup();
    const script = s.one<any>("SELECT * FROM tasks WHERE stage=2")!;
    s.updateTask(script.id, 1, "approved");
    const assets = s.one<any>("SELECT * FROM tasks WHERE stage=3")!;
    s.setVisualTemplate(p.id, "donghua3d");
    expect(s.project(p.id).template).toBe("donghua3d");
    expect(s.task(script.id).status).toBe("approved");
    expect(s.task(script.id).revision).toBe(1);
    expect(s.task(assets.id).revision).toBe(2);
    expect(s.task(assets.id).error).toBe("");
    s.updateTask(assets.id, 2, "running");
    expect(() => s.setVisualTemplate(p.id, "cel")).toThrow("执行");
    expect(() => s.setVisualTemplate(p.id, "missing")).toThrow("视觉模板");
  });
  test("画风说明写入作品，生成读作品锁定文本而不是启动时的另一份副本", () => {
    const { s, p } = setup();
    expect(s.visualStyle(p.id).prompt).toContain("赛璐璐");
    s.setVisualTemplate(p.id, "donghua3d");
    expect(s.visualStyle(p.id).id).toBe("donghua3d");
    expect(s.visualStyle(p.id).prompt).toContain("UNIVERSAL XIANXIA STYLE");
    expect(s.visualStyle(p.id).prompt).toContain("clear cold immortal aura");
    expect(s.visualStyle(p.id).referenceImageId).toBeFalsy();
    const assets = s.one<any>("SELECT * FROM tasks WHERE stage=3")!;
    const rev = assets.revision;
    const row = s.one<{ data: string }>(
      "SELECT data FROM project_settings WHERE projectId=?",
      p.id,
    )!;
    s.db.run("UPDATE project_settings SET data=? WHERE projectId=?", [
      JSON.stringify({
        ...JSON.parse(row.data),
        visual: {
          id: "donghua3d",
          name: "三维仙侠国漫",
          prompt: "旧画风文本：高完成度东方仙侠",
          version: "xianxia-3d-v3",
        },
      }),
      p.id,
    ]);
    expect(s.visualStyle(p.id).prompt).toBe("旧画风文本：高完成度东方仙侠");
    expect(s.visualStyle(p.id).version).toBe("xianxia-3d-v3");
    s.setVisualTemplate(p.id, "donghua3d");
    expect(s.visualStyle(p.id).prompt).toContain("UNIVERSAL XIANXIA STYLE");
    expect(s.visualStyle(p.id).version).toBe("xianxia-universal-v3");
    expect(s.visualStyle(p.id).characterModule).toContain("character sheet");
    expect(s.task(assets.id).revision).toBe(rev + 1);
    s.db.run("UPDATE project_settings SET data=? WHERE projectId=?", [
      JSON.stringify({
        ...JSON.parse(
          s.one<{ data: string }>(
            "SELECT data FROM project_settings WHERE projectId=?",
            p.id,
          )!.data,
        ),
        visual: {
          id: "donghua3d",
          name: "三维仙侠国漫",
          prompt: "High-finish 3D photorealistic cinematic xianxia production look.",
          version: "xianxia-style-dna-v2",
          referenceImageId: "old-brown-studio",
        },
      }),
      p.id,
    ]);
    expect(s.visualStyle(p.id).version).toBe("xianxia-universal-v3");
    expect(s.visualStyle(p.id).prompt).toContain("clear cold immortal aura");
    expect(s.visualStyle(p.id).referenceImageId).toBeNull();
    expect(s.visualStyle(p.id).prompt).not.toContain(
      "High-finish 3D photorealistic cinematic",
    );
    const looks = s.tasks(p.id).find((t) => t.stage === 3)!;
    s.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", [
      "kept-style-ref", p.id, looks.id, looks.revision, "image", "仙侠风格参考",
      "/tmp/kept-style-ref.png", "image/png", "{}", "now",
    ]);
    s.db.run("UPDATE project_settings SET data=? WHERE projectId=?", [
      JSON.stringify({
        ...JSON.parse(
          s.one<{ data: string }>(
            "SELECT data FROM project_settings WHERE projectId=?",
            p.id,
          )!.data,
        ),
        visual: {
          id: "donghua3d",
          name: "三维仙侠国漫",
          prompt: "High-finish 3D photorealistic cinematic xianxia production look.",
          version: "xianxia-universal-v1",
          referenceImageId: "kept-style-ref",
        },
      }),
      p.id,
    ]);
    expect(s.visualStyle(p.id).version).toBe("xianxia-universal-v3");
    expect(s.visualStyle(p.id).referenceImageId).toBe("kept-style-ref");
  });
  test("重启保留未知费用并使旧执行失效", () => {
    const { s, p, t } = setup();
    s.claim(t.id, 1, {});
    s.reserve(p.id, "one", connection);
    s.recover();
    expect(s.task(t.id).status).toBe("paused");
    expect(s.task(t.id).revision).toBe(2);
    expect(s.one<any>("SELECT status FROM costs")!.status).toBe("unknown");
    expect(() => s.reserve(p.id, "two", connection)).toThrow();
  });
});

test("每种新画风及新参考清除旧图片和视频引用，保留内容与历史", () => {
  const { s, p } = setup();
  try {
    const looks = s.tasks(p.id).find((t) => t.stage === 3)!;
    const frame = s.tasks(p.id).find((t) => t.stage === 4)!;
    const asset = { id: "hero", name: "女孩", kind: "character", prompt: "女孩穿蓝衣", imageId: "old-image", libraryId: "old-library", generationStyleKey: "old-key", candidates: ["old-image"], candidateSpecs: { "old-image": {} } };
    const original = s.publish(looks.id, looks.revision, JSON.stringify({ type: "assets", data: { summary: "全剧", assets: [asset], voices: [{ character: "女孩", audioId: "voice" }] } }));
    s.publish(frame.id, frame.revision, JSON.stringify({ type: "storyboard", data: { summary: "关键帧", shots: [{ id: "shot", imageId: "frame", videoId: "video", sourceAudioId: "video-audio", prompt: "动作" }], previewId: "preview" } }));
    let generation = s.visualRevision(p.id);
    for (const style of ["donghua3d", "ink", "cel", "donghua3d"]) {
      s.setVisualTemplate(p.id, style);
      expect(s.visualRevision(p.id)).toBe(++generation);
      const current = s.task(looks.id);
      const content = JSON.parse(s.one<any>("SELECT content FROM artifacts WHERE taskId=? AND revision=?", looks.id, current.revision)!.content);
      expect(content.data.assets[0].prompt).toBe(asset.prompt);
      expect(content.data.assets[0].imageId).toBeUndefined();
      expect(content.data.assets[0].libraryId).toBeUndefined();
      expect(content.data.assets[0].candidateSpecs).toBeUndefined();
      expect(content.data.assets[0].generationStyleKey).toBeUndefined();
      expect(content.data.voices[0].audioId).toBe("voice");
    }
    const rendered = JSON.parse(s.one<any>("SELECT content FROM artifacts WHERE taskId=? AND revision=?", frame.id, s.task(frame.id).revision)!.content);
    expect(rendered.data.shots[0].imageId).toBeUndefined();
    expect(rendered.data.shots[0].videoId).toBeUndefined();
    expect(rendered.data.shots[0].sourceAudioId).toBeUndefined();
    expect(rendered.data.previewId).toBeUndefined();
    expect(s.one<any>("SELECT content FROM artifacts WHERE id=?", original.id).content).toContain("old-image");
    s.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", ["reference", p.id, looks.id, 1, "image", "参考", "/test", "image/png", "{}", "now"]);
    const revision = s.task(looks.id).revision;
    s.setVisualReference(p.id, "reference");
    expect(s.task(looks.id).revision).toBe(revision + 1);
    expect(s.visualStyle(p.id).referenceImageId).toBe("reference");
    expect(s.visualRevision(p.id)).toBe(++generation);
    s.setVisualReference(p.id, "reference");
    expect(s.task(looks.id).revision).toBe(revision + 1);
    expect(s.visualRevision(p.id)).toBe(generation);
  } finally { s.db.close(); }
});

test("画风 ID 和主提示词不变时，模块版本更新仍使旧定妆失效", () => {
  const { s, p } = setup();
  try {
    s.setVisualTemplate(p.id, "donghua3d");
    const looks = s.tasks(p.id).find((t) => t.stage === 3)!;
    s.patchSettings(p.id, { visual: { ...s.visualStyle(p.id), characterModule: "旧人物模块" } });
    s.setVisualTemplate(p.id, "donghua3d");
    expect(s.task(looks.id).revision).toBe(looks.revision + 1);
    expect(s.visualStyle(p.id).characterModule).not.toBe("旧人物模块");
  } finally { s.db.close(); }
});

test("仙侠无主参考的正式资产不入库；沈不言可先入库", () => {
  const { s, p } = setup();
  s.setVisualTemplate(p.id, "donghua3d");
  const t = s.tasks(p.id).find((task) => task.stage === 3)!;
  const bundle = (assets: object[]) =>
    JSON.stringify({
      type: "assets",
      data: { summary: "资产", assets, voices: [] },
    });
  const girl = {
    id: "su-wanqing:child",
    name: "苏晚晴",
    kind: "character",
    prompt: "外观",
    identity: "幼女",
    state: "基础",
    imageId: "img-girl",
    generationStyleVersion: "xianxia-style-dna-v5",
  };
  const shen = {
    id: "shen-buyan:youth",
    name: "沈不言",
    kind: "character",
    prompt: "外观",
    identity: "剑修",
    state: "基础",
    imageId: "img-shen",
    generationStyleVersion: "xianxia-style-dna-v5",
  };
  s.registerAssets(t, bundle([girl]));
  expect(s.assetLibrary(p.id)).toHaveLength(0);
  s.registerAssets(t, bundle([shen]));
  expect(s.assetLibrary(p.id).map((a: { id: string }) => a.id)).toEqual([
    "shen-buyan:youth",
  ]);
  s.registerAssets(
    t,
    bundle([{ ...girl, generationReferenceIds: ["img-shen"] }]),
  );
  expect(s.assetLibrary(p.id).map((a: { id: string }) => a.id).sort()).toEqual([
    "shen-buyan:youth",
    "su-wanqing:child",
  ]);
});

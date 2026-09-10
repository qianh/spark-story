import { test, expect } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/store";
import { Runtime } from "../apps/server/runtime";
import { planIssues, storySchema } from "../packages/series";
import {
  storyFixture,
  planFixture,
  approveFixture,
  seedSeries,
  seriesResponse,
  scriptFixture,
} from "./fixtures/series";
import type { Connection, Task } from "../packages/domain";
const input = {
  name: "逐集验证",
  source: "女孩收到来信",
  inputType: "idea" as const,
  aspect: "9:16",
  template: "cel",
  budget: 0,
};
const connection: Connection = {
  id: "test",
  name: "Test",
  transport: "cli",
  provider: "codex",
  executable: "/test",
  model: "",
  baseUrl: "",
  keyEnv: "",
  reserveCents: 0,
  health: "installed",
  version: "test",
};
async function done(r: Runtime) {
  for (let i = 0; i < 500 && r.active.size; i++) await Bun.sleep(10);
  expect(r.active.size).toBe(0);
}
function setup() {
  const s = new Store(":memory:");
  const p = s.createProject(input);
  return { s, p };
}
function bind(s: Store) {
  s.saveConnection(connection);
  for (const role of ["主模型", "文本模型"])
    s.db.run("INSERT INTO bindings VALUES(?,?)", [role, connection.id]);
}

test("完整故事是分集前置；确认分集创建每集独立任务且事件可跨集", () => {
  const { s, p } = setup();
  try {
    approveFixture(s, p.id, 0, "概要");
    expect(s.tasks(p.id).find((t) => t.stage === 7)?.status).toBe("ready");
    expect(s.canRun(s.tasks(p.id).find((t) => t.stage === 1)!)).toBe(false);
    approveFixture(s, p.id, 7, JSON.stringify(storyFixture));
    expect(planIssues(planFixture, storySchema.parse(storyFixture))).toEqual(
      [],
    );
    approveFixture(s, p.id, 1, JSON.stringify(planFixture));
    expect(s.board(p.id).episodes).toHaveLength(2);
    const scripts = s.tasks(p.id).filter((t) => t.stage === 2);
    expect(scripts.map((t) => t.episode)).toEqual([1, 2]);
    expect(scripts.every((t) => s.canRun(t))).toBe(true);
    expect(
      s
        .tasks(p.id)
        .filter((t) => t.stage === 8)
        .every((t) => t.status === "blocked"),
    ).toBe(true);
  } finally {
    s.db.close();
  }
});
test("分集拒绝遗漏、重复和未知段落", () => {
  const story = storySchema.parse(storyFixture);
  for (const ids of [[], ["CH001-B001", "CH001-B001"], ["missing"]]) {
    const plan = structuredClone(planFixture);
    plan.episodes[0].sourceBeatIds = ids;
    expect(planIssues(plan, story).length).toBeGreaterThan(0);
  }
});
test("第二集只读取本集来源；修改第一集只失效本集下游", async () => {
  const { s, p } = setup();
  const root = await mkdtemp(join(tmpdir(), "series-scope-"));
  bind(s);
  const prompts: string[] = [];
  const r = new Runtime(s, root, async (_c, p) => {
    prompts.push(p);
    return seriesResponse(p);
  });
  try {
    seedSeries(s, p.id);
    const t = s.tasks(p.id).find((t) => t.stage === 2 && t.episode === 2)!;
    r.start(t.id, t.revision);
    await done(r);
    expect(s.task(t.id).status).toBe("awaiting_user");
    const prompt = prompts.find((p) => p.startsWith("你是单集剧情"))!;
    expect(prompt).toContain("EP002");
    expect(prompt).toContain(storyFixture.chapters[1].content);
    expect(prompt).not.toContain(storyFixture.chapters[0].content);
    const one = s.tasks(p.id).find((t) => t.stage === 2 && t.episode === 1)!;
    const before = s.tasks(p.id).filter((t) => t.episode === 2);
    r.intervene(one.id, one.revision, "");
    expect(s.tasks(p.id).filter((t) => t.episode === 2)).toEqual(before);
    expect(
      s
        .tasks(p.id)
        .filter((t) => t.episode === 1 && t.stage !== 2)
        .every((t) => t.status === "blocked"),
    ).toBe(true);
  } finally {
    r.shutdown();
    await done(r);
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("故事章二断线，重启续写保留已通过章一；实时正文可见", async () => {
  const { s, p } = setup();
  const root = await mkdtemp(join(tmpdir(), "series-resume-"));
  bind(s);
  let breakOnce = true;
  const prompts: string[] = [];
  const r = new Runtime(
    s,
    root,
    async (_c, p, _cwd, _signal, _event, _images, onText) => {
      prompts.push(p);
      if (
        p.startsWith("你是故事 Agent") &&
        p.includes('当前章：{"id":"CH002"') &&
        breakOnce
      ) {
        breakOnce = false;
        throw Error("模拟连接中断");
      }
      const result = seriesResponse(p);
      onText?.(result);
      return result;
    },
  );
  try {
    approveFixture(s, p.id, 0, "概要");
    let t = s.tasks(p.id).find((t) => t.stage === 7)!;
    r.start(t.id, t.revision);
    await done(r);
    expect(s.task(t.id).status).toBe("provider_blocked");
    expect(
      s.list(
        "SELECT * FROM planning_checkpoints WHERE kind='章节 CH001' AND status='reviewed'",
      ),
    ).toHaveLength(1);
    s.updateTask(t.id, t.revision, "running");
    s.recover();
    t = s.task(t.id);
    r.start(t.id, t.revision);
    await done(r);
    expect(s.task(t.id).status).toBe("awaiting_user");
    expect(
      prompts.filter(
        (p) =>
          p.startsWith("你是故事 Agent") && p.includes('当前章：{"id":"CH001"'),
      ),
    ).toHaveLength(1);
    expect(
      s.list(
        "SELECT * FROM planning_checkpoints WHERE kind='章节 CH002' AND status='reviewed'",
      ),
    ).toHaveLength(1);
  } finally {
    r.shutdown();
    await done(r);
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("重复格式错误达到片段上限，直接恢复不会无限重试", async () => {
  const { s, p } = setup();
  const root = await mkdtemp(join(tmpdir(), "series-limit-"));
  bind(s);
  let calls = 0;
  const r = new Runtime(s, root, async () => {
    calls++;
    return '{"chapters":';
  });
  try {
    approveFixture(s, p.id, 0, "概要");
    let t = s.tasks(p.id).find((t) => t.stage === 7)!;
    r.start(t.id, t.revision);
    await done(r);
    expect(calls).toBe(3);
    expect(s.task(t.id).status).toBe("needs_user");
    r.start(t.id, t.revision);
    await done(r);
    expect(calls).toBe(3);
  } finally {
    r.shutdown();
    await done(r);
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("编辑或批准第二集剧本不能冒用第一集来源", () => {
  const { s, p } = setup();
  try {
    seedSeries(s, p.id);
    const t = s.tasks(p.id).find((t) => t.stage === 2 && t.episode === 2)!;
    expect(s.validateArtifact(t, scriptFixture(1)).join()).toContain("边界");
    expect(s.validateArtifact(t, scriptFixture(2))).toEqual([]);
  } finally {
    s.db.close();
  }
});
test("资产库版本不可变，跨项目不能引用；新增版本不覆盖旧素材", () => {
  const { s, p } = setup();
  try {
    seedSeries(s, p.id);
    const t = s.tasks(p.id).find((t) => t.stage === 3 && t.episode === 0)!;
    for (const id of ["img1", "img2"])
      s.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", [
        id,
        p.id,
        t.id,
        t.revision,
        "image",
        id,
        "/test",
        "image/png",
        "{}",
        "now",
      ]);
    const asset = {
      id: "hero",
      name: "女孩",
      kind: "character",
      prompt: "外观",
      identity: "女孩",
      state: "幼年",
      imageId: "img1",
    };
    const bundle = (a: any) =>
      JSON.stringify({
        type: "assets",
        data: { summary: "资产", assets: [a], voices: [] },
      });
    s.registerAssets(t, bundle(asset));
    const first = s.assetLibrary(p.id)[0];
    s.registerAssets(t, bundle({ ...asset, state: "成年", imageId: "img2" }));
    expect(s.assetLibrary(p.id)).toHaveLength(2);
    expect(
      s.assetLibrary(p.id).find((a) => a.libraryId === first.libraryId)
        ?.imageId,
    ).toBe("img1");
    expect(
      s.validateArtifact(t, bundle({ ...asset, libraryId: first.libraryId })),
    ).toEqual([]);
    expect(
      s
        .validateArtifact(
          t,
          bundle({ ...asset, libraryId: first.libraryId, state: "成年" }),
        )
        .join(),
    ).toContain("版本");
    const other = s.createProject({ ...input, name: "另一个作品" });
    const otherTask = s.tasks(other.id).find((t) => t.stage === 3)!;
    expect(
      s.validateArtifact(
        otherTask,
        bundle({ ...asset, libraryId: first.libraryId }),
      ).length,
    ).toBeGreaterThan(0);
  } finally {
    s.db.close();
  }
});

test("真实七阶段数据库迁移备份、保留历史、加入故事前置并且幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "series-migrate-")),
    path = join(root, "state.sqlite");
  let s = new Store(path);
  try {
    const p = s.createProject(input);
    const outline = s.tasks(p.id).find((t) => t.stage === 0)!;
    approveFixture(s, p.id, 0, "已确认概要");
    s.db.exec("PRAGMA foreign_keys=OFF");
    s.db.exec(
      `CREATE TABLE tasks_old(id TEXT PRIMARY KEY,projectId TEXT REFERENCES projects(id),stage INTEGER,title TEXT,role TEXT,status TEXT,revision INTEGER DEFAULT 1,round INTEGER DEFAULT 0,instruction TEXT DEFAULT '',error TEXT DEFAULT '',updatedAt TEXT,UNIQUE(projectId,stage)); INSERT INTO tasks_old SELECT id,projectId,stage,title,role,status,revision,round,instruction,error,updatedAt FROM tasks WHERE stage<7; DROP TABLE tasks; ALTER TABLE tasks_old RENAME TO tasks;`,
    );
    s.db.close();
    s = new Store(path);
    expect(s.tasks(p.id)).toHaveLength(9);
    expect(s.task(outline.id).status).toBe("approved");
    expect(s.tasks(p.id).find((t) => t.stage === 7)?.status).toBe("ready");
    expect(s.tasks(p.id).find((t) => t.stage === 1)?.status).toBe("blocked");
    expect(s.list("PRAGMA foreign_key_check")).toEqual([]);
    const before = s.tasks(p.id);
    s.db.close();
    s = new Store(path);
    expect(s.tasks(p.id)).toEqual(before);
    expect(
      (await readdir(root)).filter((p) => p.includes("before-series")),
    ).toHaveLength(1);
  } finally {
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("章节局部修改保留前文检查点，并重新验证后续衔接", async () => {
  const { s, p } = setup();
  const root = await mkdtemp(join(tmpdir(), "series-repair-"));
  bind(s);
  const prompts: string[] = [];
  const r = new Runtime(s, root, async (_c, p) => {
    prompts.push(p);
    return seriesResponse(p);
  });
  try {
    approveFixture(s, p.id, 0, "概要");
    let t = s.tasks(p.id).find((t) => t.stage === 7)!;
    r.start(t.id, t.revision);
    await done(r);
    s.repairChapter(t.id, t.revision, "CH002", "补足决定留下的动机");
    t = s.task(t.id);
    expect(
      s.list(
        "SELECT * FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind='章节 CH001' AND status='reviewed'",
        t.id,
        t.revision,
      ),
    ).toHaveLength(1);
    expect(
      s.list(
        "SELECT * FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind='章节 CH002'",
        t.id,
        t.revision,
      ),
    ).toHaveLength(0);
    r.start(t.id, t.revision);
    await done(r);
    expect(s.task(t.id).status).toBe("awaiting_user");
    expect(
      prompts.filter(
        (p) =>
          p.startsWith("你是故事 Agent") && p.includes('当前章：{"id":"CH001"'),
      ),
    ).toHaveLength(1);
  } finally {
    r.shutdown();
    await done(r);
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const pass of [true, false]) {
  test(`直接编辑正文必须逐章审核，正文审核${pass ? "通过才整体审核" : "失败保留原稿"}`, async () => {
    const { s, p } = setup();
    const root = await mkdtemp(join(tmpdir(), "series-edited-"));
    bind(s);
    const prompts: string[] = [];
    const r = new Runtime(s, root, async (_c, prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ pass, feedback: "正文审核结果" });
    });
    try {
      approveFixture(s, p.id, 0, "概要");
      const t = s.tasks(p.id).find((t) => t.stage === 7)!;
      const edited = structuredClone(storyFixture);
      edited.chapters[0].content += "女孩烧毁了来信，与段落索引矛盾。";
      // A reviewed checkpoint for different prose must not authorize this edit.
      s.db.run("INSERT INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)", [
        crypto.randomUUID(),
        t.id,
        t.revision,
        "章节 CH001",
        JSON.stringify(storyFixture.chapters[0]),
        "reviewed",
        new Date().toISOString(),
      ]);
      const artifact = s.publish(t.id, t.revision, JSON.stringify(edited));
      r.start(t.id, t.revision);
      await done(r);
      expect(prompts[0]).toContain(edited.chapters[0].content);
      expect(prompts.every((p) => p.startsWith("你是主控"))).toBe(true);
      expect(prompts).toHaveLength(pass ? 3 : 1);
      if (pass) {
        expect(prompts[1]).toContain(edited.chapters[1].content);
        expect(prompts[2]).not.toContain(edited.chapters[0].content);
      }
      expect(s.task(t.id).status).toBe(pass ? "awaiting_user" : "needs_user");
      const saved = s.one<{ content: string; status: string }>(
        "SELECT content,status FROM artifacts WHERE id=?",
        artifact.id,
      )!;
      expect(saved.content).toBe(JSON.stringify(edited));
      expect(saved.status).toBe(pass ? "reviewed" : "rejected");
    } finally {
      r.shutdown();
      await done(r);
      s.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("全剧定妆只依赖完整故事，分集修改不使其失效，各集关键帧共享同一任务", () => {
  const { s, p } = setup();
  try {
    approveFixture(s, p.id, 0, "概要");
    approveFixture(s, p.id, 7, JSON.stringify(storyFixture));
    const looks = s.tasks(p.id).find((t) => t.stage === 3)!;
    expect(looks.episode).toBe(0);
    expect(s.canRun(looks)).toBe(true);
    expect(s.dependencies(looks).map((t) => t.stage)).toEqual([0, 7]);
    approveFixture(s, p.id, 1, JSON.stringify(planFixture));
    expect(s.tasks(p.id).filter((t) => t.stage === 3)).toHaveLength(1);
    const frames = s.tasks(p.id).filter((t) => t.stage === 4);
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(s.dependencies(frame).find((t) => t.stage === 3)?.id).toBe(looks.id);
    const plan = s.tasks(p.id).find((t) => t.stage === 1)!;
    s.invalidateAfter(plan);
    expect(s.task(looks.id)).toEqual(looks);
    s.invalidateAfter(looks);
    expect(frames.every((t) => s.task(t.id).revision > t.revision)).toBe(true);
  } finally { s.db.close(); }
});

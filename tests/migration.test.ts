import { test, expect } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/store";
import type { Task, Artifact } from "../packages/domain";
test("旧六阶段作品安全升级：概要保留、插入规划、下游待重新确认、备份且幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-migration-")),
    path = join(root, "state.sqlite");
  let s = new Store(path);
  try {
    const p = s.createProject({
      name: "旧作品",
      source: "来源",
      inputType: "idea",
      aspect: "9:16",
      template: "cel",
      budget: 0,
    });
    s.db.run("DELETE FROM tasks WHERE projectId=?", [p.id]);
    [
      "故事概要",
      "本集剧本",
      "定妆与资产",
      "分镜预览",
      "正式镜头",
      "后期成片",
    ].forEach((title, stage) =>
      s.db.run(
        "INSERT INTO tasks(id,projectId,stage,title,role,status,updatedAt) VALUES(?,?,?,?,?,?,?)",
        [
          `legacy-${stage}`,
          p.id,
          stage,
          title,
          "剧情 Agent",
          stage < 2 ? "approved" : "blocked",
          new Date().toISOString(),
        ],
      ),
    );
    const outline = s.publish("legacy-0", 1, "已确认的原概要"),
      script = s.publish("legacy-1", 1, "旧版第一集");
    s.db.run("UPDATE artifacts SET status='approved'");
    s.db.close();
    s = new Store(path);
    const tasks = s.list<Task>(
      "SELECT * FROM tasks WHERE projectId=? ORDER BY stage",
      p.id,
    );
    expect(tasks).toHaveLength(9);
    expect(tasks[0].status).toBe("approved");
    expect(tasks[1].title).toBe("全剧分集规划");
    expect(tasks[1].status).toBe("blocked");
    expect(tasks[7].status).toBe("ready");
    expect(tasks[2].id).toBe("legacy-1");
    expect(tasks[2].status).toBe("blocked");
    expect(
      s.one<Artifact>("SELECT * FROM artifacts WHERE id=?", outline.id)?.status,
    ).toBe("approved");
    expect(
      s.one<Artifact>("SELECT * FROM artifacts WHERE id=?", script.id)?.content,
    ).toBe("旧版第一集");
    expect(s.canRun(tasks[2])).toBe(false);
    const before = JSON.stringify(tasks);
    s.db.close();
    s = new Store(path);
    expect(
      JSON.stringify(
        s.list<Task>(
          "SELECT * FROM tasks WHERE projectId=? ORDER BY stage",
          p.id,
        ),
      ),
    ).toBe(before);
    expect(
      (await readdir(root)).filter((n) => n.includes("before-episode-plan")),
    ).toHaveLength(1);
  } finally {
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("多集定妆迁移合并为全剧任务，历史图片和产物保留且重启幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "global-looks-migration-"));
  const path = join(root, "state.sqlite");
  let s = new Store(path);
  try {
    const p = s.createProject({ name: "定妆迁移", source: "故事", inputType: "idea", aspect: "9:16", template: "cel", budget: 0 });
    const first = s.tasks(p.id).find((t) => t.stage === 3)!;
    s.db.run("UPDATE tasks SET episode=1 WHERE id=?", [first.id]);
    s.createTask(p.id, 3, 2);
    const second = s.one<Task>("SELECT * FROM tasks WHERE projectId=? AND stage=3 AND episode=2", p.id)!;
    const a1 = s.publish(first.id, 1, "第一集旧定妆");
    const a2 = s.publish(second.id, 1, "第二集旧定妆");
    s.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", ["old-image", p.id, second.id, 1, "image", "历史", "/original.png", "image/png", "{}", "now"]);
    s.db.close();
    s = new Store(path);
    const looks = s.tasks(p.id).filter((t) => t.stage === 3);
    expect(looks).toHaveLength(1);
    expect(looks[0].id).toBe(first.id);
    expect(looks[0].episode).toBe(0);
    expect(looks[0].revision).toBe(3);
    expect(s.one<any>("SELECT * FROM artifacts WHERE id=?", a1.id).content).toBe("第一集旧定妆");
    const moved = s.one<Artifact>("SELECT * FROM artifacts WHERE id=?", a2.id)!;
    expect(moved.taskId).toBe(first.id);
    expect(moved.revision).toBe(2);
    expect(moved.status).toBe("superseded");
    expect(s.one<any>("SELECT * FROM media_files WHERE id='old-image'").path).toBe("/original.png");
    expect(s.list("SELECT * FROM workflow_task_history")).toHaveLength(2);
    expect(s.list("PRAGMA foreign_key_check")).toEqual([]);
    s.db.close();
    s = new Store(path);
    expect(s.tasks(p.id).filter((t) => t.stage === 3)).toEqual(looks);
    expect((await readdir(root)).filter((f) => f.includes("before-global-looks"))).toHaveLength(1);
  } finally { s.db.close(); await rm(root, { recursive: true, force: true }); }
});

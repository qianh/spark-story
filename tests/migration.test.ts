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
    expect(tasks).toHaveLength(7);
    expect(tasks[0].status).toBe("approved");
    expect(tasks[1].title).toBe("全剧分集规划");
    expect(tasks[1].status).toBe("ready");
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

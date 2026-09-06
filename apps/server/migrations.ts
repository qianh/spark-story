import type { Store } from "./store";
import type { Task } from "../../packages/domain";
export function upgradeEpisodePlanning(store: Store, path: string) {
  const legacy = store.list<{ projectId: string }>(
    "SELECT projectId FROM tasks GROUP BY projectId HAVING COUNT(*)=6 AND MAX(stage)=5 AND SUM(CASE WHEN title='本集剧本' AND stage=1 THEN 1 ELSE 0 END)=1",
  );
  if (!legacy.length) return;
  // Snapshot the whole database before changing task order; original files remain untouched.
  if (path !== ":memory:")
    store.db.run("VACUUM INTO ?", [
      `${path}.before-episode-plan-${crypto.randomUUID()}.sqlite`,
    ]);
  store.db.transaction(() => {
    for (const { projectId } of legacy) {
      const tasks = store.list<Task>(
          "SELECT * FROM tasks WHERE projectId=? ORDER BY stage DESC",
          projectId,
        ),
        now = new Date().toISOString();
      for (const t of tasks.filter((t) => t.stage > 0)) {
        store.db.run(
          "UPDATE tasks SET stage=stage+1,title=?,revision=revision+1,status='blocked',error='流程已新增全剧分集规划；旧产物保留，待规划确认后重新审核制作。',updatedAt=? WHERE id=?",
          [t.stage === 1 ? "第一集剧本" : t.title, now, t.id],
        );
        store.db.run(
          "UPDATE artifacts SET status='superseded' WHERE taskId=?",
          [t.id],
        );
        store.db.run(
          "UPDATE attempts SET status='interrupted' WHERE taskId=? AND status='running'",
          [t.id],
        );
      }
      store.db.run(
        "INSERT INTO tasks(id,projectId,stage,title,role,status,updatedAt) VALUES(?,?,?,?,?,?,?)",
        [
          crypto.randomUUID(),
          projectId,
          1,
          "全剧分集规划",
          "分集规划 Agent",
          tasks.find((t) => t.stage === 0)?.status === "approved"
            ? "ready"
            : "blocked",
          now,
        ],
      );
      store.event(
        projectId,
        "",
        "workflow.upgraded",
        "已新增全剧分集规划。故事概要及其确认状态不变；先确认全剧集数与每集走向，再制作第一集。旧产物和媒体文件保留。",
      );
    }
  })();
}

export function upgradeSeriesWorkflow(store: Store, path: string) {
  const hasEpisode = store
    .list<{ name: string }>("PRAGMA table_info(tasks)")
    .some((c) => c.name === "episode");
  const legacy = store.list<{ id: string }>(
    "SELECT p.id FROM projects p WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.projectId=p.id AND t.stage=7)",
  );
  if (hasEpisode && !legacy.length) return;
  if (path !== ":memory:" && store.one("SELECT id FROM projects LIMIT 1"))
    store.db.run("VACUUM INTO ?", [
      `${path}.before-series-${crypto.randomUUID()}.sqlite`,
    ]);
  store.db.exec("PRAGMA foreign_keys=OFF");
  try {
    store.db.transaction(() => {
      if (!hasEpisode)
        store.db
          .exec(`CREATE TABLE tasks_series(id TEXT PRIMARY KEY,projectId TEXT REFERENCES projects(id),stage INTEGER,title TEXT,role TEXT,status TEXT,revision INTEGER DEFAULT 1,round INTEGER DEFAULT 0,instruction TEXT DEFAULT '',error TEXT DEFAULT '',updatedAt TEXT,episode INTEGER NOT NULL DEFAULT 0, UNIQUE(projectId,stage,episode));
        INSERT INTO tasks_series SELECT *,CASE WHEN stage>=2 THEN 1 ELSE 0 END FROM tasks;
        DROP TABLE tasks; ALTER TABLE tasks_series RENAME TO tasks;`);
      for (const p of legacy) {
        if (hasEpisode)
          store.db.run(
            "UPDATE tasks SET episode=CASE WHEN stage>=2 THEN 1 ELSE 0 END WHERE projectId=?",
            [p.id],
          );
        const approved =
          store.one<{ status: string }>(
            "SELECT status FROM tasks WHERE projectId=? AND stage=0",
            p.id,
          )?.status === "approved";
        store.db.run(
          "UPDATE tasks SET revision=revision+1,round=0,status='blocked',error='流程升级：请先完成全剧故事稿，再重新拆集。旧产物保留。' WHERE projectId=? AND stage>0",
          [p.id],
        );
        store.db.run(
          "UPDATE tasks SET title='单集剧本' WHERE projectId=? AND stage=2",
          [p.id],
        );
        for (const [stage, title, episode] of [
          [7, "完整故事稿", 0],
          [8, "文字分镜", 1],
        ] as const)
          store.db.run(
            "INSERT INTO tasks(id,projectId,stage,title,role,status,updatedAt,episode) VALUES(?,?,?,?,?,?,?,?)",
            [
              crypto.randomUUID(),
              p.id,
              stage,
              title,
              stage === 7 ? "故事 Agent" : "分镜 Agent",
              stage === 7 && approved ? "ready" : "blocked",
              new Date().toISOString(),
              episode,
            ],
          );
        store.event(
          p.id,
          "",
          "workflow.upgraded",
          "已升级为全剧故事先完成、拆集后逐集制作。概要与历史产物保留；旧分集不直接作为新流程依据。数据库已备份。",
        );
      }
    })();
  } finally {
    store.db.exec("PRAGMA foreign_keys=ON");
  }
  if (store.list("PRAGMA foreign_key_check").length)
    throw Error("流程迁移后的数据引用检查失败");
}

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

/** Consolidate episode looks without discarding artifacts, media or task history. */
export function upgradeGlobalLooks(store: Store, path: string) {
  const projects = store.list<{ projectId: string }>(
    "SELECT DISTINCT projectId FROM tasks WHERE stage=3 AND episode<>0",
  );
  if (!projects.length) return;
  if (path !== ":memory:") store.db.run("VACUUM INTO ?", [`${path}.before-global-looks-${crypto.randomUUID()}.sqlite`]);
  store.db.transaction(() => {
    store.db.exec("CREATE TABLE IF NOT EXISTS workflow_task_history(id TEXT PRIMARY KEY,data TEXT,createdAt TEXT)");
    for (const { projectId } of projects) {
      const tasks = store.list<Task>("SELECT * FROM tasks WHERE projectId=? AND stage=3 ORDER BY episode", projectId);
      const canonical = tasks[0]!;
      let revision = 0;
      for (const task of tasks) {
        store.db.run("INSERT OR IGNORE INTO workflow_task_history VALUES(?,?,?)", [task.id, JSON.stringify(task), new Date().toISOString()]);
        // Offset each old task's revisions so every historical artifact/job remains distinguishable.
        for (const table of ["artifacts", "attempts", "interventions", "media_files", "media_jobs", "planning_checkpoints", "asset_library"])
          store.db.run(`UPDATE ${table} SET taskId=?,revision=revision+? WHERE taskId=?`, [canonical.id, revision, task.id]);
        if (task.id !== canonical.id) {
          store.db.run("UPDATE events SET taskId=? WHERE taskId=?", [canonical.id, task.id]);
          for (const table of ["task_progress", "media_review_progress"]) {
            const progress = store.one(`SELECT * FROM ${table} WHERE taskId=?`, task.id);
            if (progress) store.db.run("INSERT OR IGNORE INTO workflow_task_history VALUES(?,?,?)", [`${table}:${task.id}`, JSON.stringify(progress), new Date().toISOString()]);
            store.db.run(`DELETE FROM ${table} WHERE taskId=?`, [task.id]);
          }
          store.db.run("DELETE FROM tasks WHERE id=?", [task.id]);
        }
        revision += task.revision;
      }
      store.db.run("UPDATE artifacts SET status='superseded' WHERE taskId=?", [canonical.id]);
      store.db.run("UPDATE attempts SET status='interrupted' WHERE taskId=? AND status='running'", [canonical.id]);
      store.db.run("UPDATE costs SET status='unknown' WHERE status='reserved' AND id IN (SELECT costId FROM media_jobs WHERE taskId=? AND status IN ('submitting','polling','downloading'))", [canonical.id]);
      store.db.run("UPDATE media_jobs SET status=CASE WHEN remoteId != '' THEN 'detached' ELSE 'unknown' END,error='全剧定妆流程迁移；远端状态待核实，未自动重发' WHERE taskId=? AND status IN ('submitting','polling','downloading')", [canonical.id]);
      store.db.run("UPDATE tasks SET episode=0,title='定妆与资产',revision=?,round=0,status='blocked',instruction='',error='定妆已改为全剧共享；历史定妆保留，请重新生成并确认完整资产。',updatedAt=? WHERE id=?", [revision + 1, new Date().toISOString(), canonical.id]);
      const current = store.task(canonical.id);
      if (store.canRun(current)) store.updateTask(current.id, current.revision, "ready");
      store.invalidateAfter(current);
      store.event(projectId, canonical.id, "workflow.global-looks", "定妆已合并为全剧共享任务，只依赖完整故事；各集关键帧使用同一份已确认定妆。原任务记录、产物与媒体文件均已保留。");
    }
  })();
  if (store.list("PRAGMA foreign_key_check").length) throw Error("全剧定妆迁移后的数据引用检查失败");
}

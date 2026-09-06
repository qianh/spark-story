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

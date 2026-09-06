import { isMediaStage } from "../../packages/series";
import type { Store } from "./store";
import type { Task, Connection } from "../../packages/domain";
import type { TaskProgress } from "../../packages/progress";

export class ProgressTracker {
  row: TaskProgress;
  private timer: ReturnType<typeof setInterval>;
  private lastWrite = 0;
  private closed = false;
  constructor(
    private store: Store,
    private task: Task,
    c: Connection,
  ) {
    const phase =
      store.task(task.id).status === "reviewing"
        ? "review"
        : store.task(task.id).status === "coordinating"
          ? "coordinate"
          : "generate";
    const previous = store.one<TaskProgress>(
      "SELECT * FROM task_progress WHERE taskId=? AND revision=?",
      task.id,
      task.revision,
    );
    const now = new Date().toISOString();
    this.row = {
      taskId: task.id,
      revision: task.revision,
      callId: crypto.randomUUID(),
      phase,
      actor: phase === "generate" ? task.role : "主控 Agent",
      model: c.name,
      content: phase === "generate" ? "" : previous?.content || "",
      startedAt: now,
      heartbeatAt: now,
      outputAt: "",
      status: "running",
    };
    store.db.run(
      "INSERT OR REPLACE INTO task_progress VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      Object.values(this.row),
    );
    this.timer = setInterval(() => this.flush(), 3000);
  }
  text = (content: string) => {
    if (this.closed) return;
    this.row.outputAt = new Date().toISOString();
    if (this.row.phase === "generate" && !isMediaStage(this.task.stage))
      this.row.content = content.slice(0, 240000);
    if (Date.now() - this.lastWrite > 300) this.flush();
  };
  private flush() {
    if (
      this.closed ||
      this.store.task(this.task.id).revision !== this.task.revision
    )
      return;
    this.lastWrite = Date.now();
    this.row.heartbeatAt = new Date().toISOString();
    this.store.db.run(
      "UPDATE task_progress SET content=?,heartbeatAt=?,outputAt=?,status=? WHERE taskId=? AND revision=? AND callId=?",
      [
        this.row.content,
        this.row.heartbeatAt,
        this.row.outputAt,
        this.row.status,
        this.row.taskId,
        this.row.revision,
        this.row.callId,
      ],
    );
  }
  finish(status: string) {
    this.row.status = status;
    this.flush();
    this.closed = true;
    clearInterval(this.timer);
  }
}

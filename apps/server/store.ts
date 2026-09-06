import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { upgradeEpisodePlanning } from "./migrations";
import {
  productionRulesSchema,
  validateTextProduction,
  type ProductionRules,
} from "../../packages/production";
import {
  stages,
  type Project,
  type Task,
  type Connection,
  type Artifact,
} from "../../packages/domain";

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
export class Store {
  db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,source TEXT,inputType TEXT,aspect TEXT,template TEXT,budget INTEGER,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,projectId TEXT REFERENCES projects(id),stage INTEGER,title TEXT,role TEXT,status TEXT,revision INTEGER DEFAULT 1,round INTEGER DEFAULT 0,instruction TEXT DEFAULT '',error TEXT DEFAULT '',updatedAt TEXT, UNIQUE(projectId,stage));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,taskId TEXT REFERENCES tasks(id),revision INTEGER,content TEXT,status TEXT,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,data TEXT);
      CREATE TABLE IF NOT EXISTS bindings(role TEXT PRIMARY KEY,connectionId TEXT REFERENCES connections(id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,projectId TEXT,taskId TEXT,type TEXT,message TEXT,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,taskId TEXT,revision INTEGER,snapshot TEXT,status TEXT,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS costs(id TEXT PRIMARY KEY,projectId TEXT,attemptId TEXT,connectionId TEXT,amount INTEGER,status TEXT,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS interventions(id TEXT PRIMARY KEY,taskId TEXT,revision INTEGER,message TEXT,proposal TEXT,status TEXT,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS media_files(id TEXT PRIMARY KEY,projectId TEXT,taskId TEXT,revision INTEGER,kind TEXT,name TEXT,path TEXT,mime TEXT,metadata TEXT,createdAt TEXT);
      CREATE TABLE IF NOT EXISTS media_jobs(id TEXT PRIMARY KEY,projectId TEXT,taskId TEXT,revision INTEGER,kind TEXT,agent TEXT,prompt TEXT,inputs TEXT,options TEXT,connection TEXT,status TEXT,remoteId TEXT,outputId TEXT,error TEXT,costId TEXT,operationKey TEXT,createdAt TEXT,updatedAt TEXT);
      CREATE INDEX IF NOT EXISTS media_jobs_task ON media_jobs(taskId,revision,operationKey);
      CREATE TABLE IF NOT EXISTS project_settings(projectId TEXT PRIMARY KEY,data TEXT);
      CREATE TABLE IF NOT EXISTS media_transcripts(fileId TEXT,connectionId TEXT,text TEXT,PRIMARY KEY(fileId,connectionId));
      CREATE INDEX IF NOT EXISTS events_project ON events(projectId,seq);
      CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(taskId,createdAt);
      CREATE TABLE IF NOT EXISTS task_progress(taskId TEXT PRIMARY KEY,revision INTEGER,callId TEXT,phase TEXT,actor TEXT,model TEXT,content TEXT,startedAt TEXT,heartbeatAt TEXT,outputAt TEXT,status TEXT);
      CREATE TABLE IF NOT EXISTS planning_checkpoints(id TEXT PRIMARY KEY,taskId TEXT,revision INTEGER,kind TEXT,content TEXT,status TEXT,createdAt TEXT);
    `);
    upgradeEpisodePlanning(this, path);
  }
  list<T>(sql: string, ...args: any[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  one<T>(sql: string, ...args: any[]): T | null {
    return this.db.query(sql).get(...args) as T | null;
  }
  event(projectId: string, taskId: string, type: string, message: string) {
    this.db.run(
      "INSERT INTO events(projectId,taskId,type,message,createdAt) VALUES(?,?,?,?,?)",
      [projectId, taskId, type, message.slice(0, 20000), now()],
    );
  }
  createProject(input: Omit<Project, "id" | "createdAt">) {
    const p = { ...input, id: id(), createdAt: now() };
    this.db.transaction(() => {
      this.db.run("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)", [
        p.id,
        p.name,
        p.source,
        p.inputType,
        p.aspect,
        p.template,
        p.budget,
        p.createdAt,
      ]);
      stages.forEach((title, stage) =>
        this.db.run(
          "INSERT INTO tasks(id,projectId,stage,title,role,status,updatedAt) VALUES(?,?,?,?,?,?,?)",
          [
            id(),
            p.id,
            stage,
            title,
            [
              "剧情 Agent",
              "分集规划 Agent",
              "剧情 Agent",
              "角色与资产 Agent",
              "分镜 Agent",
              "视频 Agent",
              "后期 Agent",
            ][stage],
            stage === 0 ? "ready" : "blocked",
            now(),
          ],
        ),
      );
      this.db.run("INSERT INTO project_settings VALUES(?,?)", [
        p.id,
        JSON.stringify({
          production: productionRulesSchema.parse(input.production || {}),
        }),
      ]);
      this.event(
        p.id,
        "",
        "project.created",
        "项目已创建。先确认故事概要，再规划全剧分集，最后细写并制作第一集。",
      );
    })();
    return p;
  }
  project(id: string) {
    const p = this.one<Project>("SELECT * FROM projects WHERE id=?", id);
    if (!p) throw Error("项目不存在");
    return p;
  }
  productionRules(projectId: string): ProductionRules {
    this.project(projectId);
    const row = this.one<{ data: string }>(
      "SELECT data FROM project_settings WHERE projectId=?",
      projectId,
    );
    return productionRulesSchema.parse(
      row ? JSON.parse(row.data).production || {} : {},
    );
  }
  saveProductionRules(projectId: string, input: unknown) {
    const production = productionRulesSchema.parse(input);
    this.project(projectId);
    return this.db.transaction(() => {
      if (
        this.one(
          "SELECT id FROM tasks WHERE projectId=? AND status IN ('running','reviewing','coordinating')",
          projectId,
        )
      )
        throw Error("项目仍在执行，请先中断任务再修改制作规则");
      if (
        this.one(
          "SELECT id FROM media_jobs WHERE projectId=? AND status IN ('submitting','polling','downloading')",
          projectId,
        )
      )
        throw Error("媒体任务仍在执行，请先停止或等待完成");
      const row = this.one<{ data: string }>(
        "SELECT data FROM project_settings WHERE projectId=?",
        projectId,
      );
      this.db.run(
        "INSERT INTO project_settings VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data",
        [
          projectId,
          JSON.stringify({ ...(row ? JSON.parse(row.data) : {}), production }),
        ],
      );
      const outline = this.one<Task>(
        "SELECT * FROM tasks WHERE projectId=? AND stage=0",
        projectId,
      )!;
      this.invalidateAfter(outline);
      this.db.run("UPDATE tasks SET round=0 WHERE projectId=? AND stage>0", [
        projectId,
      ]);
      if (outline.status === "approved")
        this.db.run(
          "UPDATE tasks SET status='ready',error='' WHERE projectId=? AND stage=1",
          [projectId],
        );
      this.event(
        projectId,
        "",
        "production.changed",
        `制作规则已更新：${production.minSeconds}～${production.maxSeconds} 秒。概要与历史产物保留；分集规划及下游需重新生成和确认。`,
      );
      return production;
    })();
  }
  task(id: string) {
    const t = this.one<Task>("SELECT * FROM tasks WHERE id=?", id);
    if (!t) throw Error("任务不存在");
    return t;
  }
  connection(id: string) {
    const row = this.one<{ data: string }>(
      "SELECT data FROM connections WHERE id=?",
      id,
    );
    if (!row) throw Error("连接不存在");
    return JSON.parse(row.data) as Connection;
  }
  connections() {
    return this.list<{ data: string }>("SELECT data FROM connections").map(
      (r) => JSON.parse(r.data) as Connection,
    );
  }
  saveConnection(c: Connection) {
    this.db.run(
      "INSERT INTO connections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      [c.id, JSON.stringify(c)],
    );
  }
  binding(role: string) {
    const row = this.one<{ connectionId: string }>(
      "SELECT connectionId FROM bindings WHERE role=?",
      role,
    );
    if (!row) throw Error(`请先配置${role}`);
    return this.connection(row.connectionId);
  }
  updateTask(taskId: string, revision: number, status: string, error = "") {
    return (
      this.db.run(
        "UPDATE tasks SET status=?,error=?,updatedAt=? WHERE id=? AND revision=?",
        [status, error, now(), taskId, revision],
      ).changes > 0
    );
  }
  claim(taskId: string, revision: number, snapshot: unknown) {
    return this.db.transaction(() => {
      const result = this.db.run(
        "UPDATE tasks SET status='running',error='',updatedAt=? WHERE id=? AND revision=? AND status IN ('ready','paused','provider_blocked','budget_blocked','needs_user')",
        [now(), taskId, revision],
      );
      if (!result.changes) throw Error("任务状态已改变，请刷新后重试");
      const attemptId = id();
      this.db.run("INSERT INTO attempts VALUES(?,?,?,?,?,?)", [
        attemptId,
        taskId,
        revision,
        JSON.stringify(snapshot),
        "running",
        now(),
      ]);
      return attemptId;
    })();
  }
  publish(taskId: string, revision: number, content: string) {
    const a: Artifact = {
      id: id(),
      taskId,
      revision,
      content,
      status:
        this.task(taskId).revision === revision ? "candidate" : "superseded",
      createdAt: now(),
    };
    this.db.run("INSERT INTO artifacts VALUES(?,?,?,?,?,?)", [
      a.id,
      a.taskId,
      a.revision,
      a.content,
      a.status,
      a.createdAt,
    ]);
    return a;
  }
  approve(taskId: string, revision: number, artifactId: string) {
    return this.db.transaction(() => {
      const t = this.task(taskId);
      const a = this.one<Artifact>(
        "SELECT * FROM artifacts WHERE id=?",
        artifactId,
      );
      if (
        t.revision !== revision ||
        t.status !== "awaiting_user" ||
        !a ||
        a.taskId !== taskId ||
        a.revision !== revision ||
        a.status !== "reviewed" ||
        !this.canRun(t)
      )
        throw Error("审核版本已变化，或尚未通过主控审核");
      const issues = validateTextProduction(
        a.content,
        t.stage,
        this.productionRules(t.projectId),
      );
      if (issues.length) throw Error(issues.join("；"));
      this.db.run(
        "UPDATE artifacts SET status='superseded' WHERE taskId=? AND status='approved'",
        [taskId],
      );
      this.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [
        artifactId,
      ]);
      this.updateTask(taskId, revision, "approved");
      this.db.run(
        "UPDATE tasks SET status='ready',updatedAt=? WHERE projectId=? AND stage=? AND status='blocked'",
        [now(), t.projectId, t.stage + 1],
      );
      this.event(
        t.projectId,
        t.id,
        "stage.approved",
        `${t.title}已确认，正式使用当前版本。`,
      );
    })();
  }
  interrupt(taskId: string, revision: number, message: string) {
    return this.db.transaction(() => {
      const t = this.task(taskId);
      if (t.revision !== revision) throw Error("任务版本已变化");
      this.db.run(
        "UPDATE tasks SET revision=revision+1,status='coordinating',round=0,error='',updatedAt=? WHERE id=?",
        [now(), taskId],
      );
      const interventionId = id();
      this.db.run("INSERT INTO interventions VALUES(?,?,?,?,?,?,?)", [
        interventionId,
        taskId,
        revision + 1,
        message,
        "",
        "pending",
        now(),
      ]);
      this.event(
        t.projectId,
        t.id,
        "task.interrupted",
        `子 Agent 已停止新动作，并向主控汇报：${message || "用户手动暂停"}`,
      );
      return { interventionId, revision: revision + 1 };
    })();
  }
  invalidateAfter(task: Task) {
    this.db.run(
      "UPDATE tasks SET revision=revision+1,status='blocked',error='上游已修改，等待重新确认',updatedAt=? WHERE projectId=? AND stage>?",
      [now(), task.projectId, task.stage],
    );
    this.event(
      task.projectId,
      task.id,
      "plan.revised",
      "主控已使下游旧修订失效；已有产物保留，等待上游重新确认。",
    );
  }
  canRun(task: Task) {
    return !this.one(
      "SELECT id FROM tasks WHERE projectId=? AND stage<? AND status<>? LIMIT 1",
      task.projectId,
      task.stage,
      "approved",
    );
  }
  reserve(projectId: string, attemptId: string, c: Connection) {
    if (c.transport === "cli") return null;
    return this.db.transaction(() => {
      const p = this.project(projectId);
      const used = this.one<{ total: number }>(
        "SELECT COALESCE(SUM(amount),0) AS total FROM costs WHERE projectId=? AND status<>'released'",
        projectId,
      )!.total;
      if (c.reserveCents < 1 || used + c.reserveCents > p.budget)
        throw Error("API 预算不足，请调整项目预算后重试");
      const reservationId = id();
      this.db.run("INSERT INTO costs VALUES(?,?,?,?,?,?,?)", [
        reservationId,
        projectId,
        attemptId,
        c.id,
        c.reserveCents,
        "reserved",
        now(),
      ]);
      return reservationId;
    })();
  }
  recover() {
    const active = this.list<Task>(
      "SELECT * FROM tasks WHERE status IN ('running','reviewing','coordinating')",
    );
    this.db.transaction(() => {
      for (const t of active) {
        this.db.run(
          "UPDATE tasks SET status='paused',revision=revision+1,error='后台重启，已暂停旧执行。请检查记录后继续。',updatedAt=? WHERE id=?",
          [now(), t.id],
        );
        this.event(
          t.projectId,
          t.id,
          "task.recovered",
          "后台已恢复任务记录；旧运行已失效，未自动重复提交。",
        );
        if (t.stage > 2) {
          const checkpoint = this.one<Artifact>(
            "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='candidate' ORDER BY createdAt DESC LIMIT 1",
            t.id,
            t.revision,
          );
          if (checkpoint)
            this.publish(t.id, t.revision + 1, checkpoint.content);
        }
      }
      this.db.run(
        "UPDATE attempts SET status='interrupted' WHERE status='running'",
      );
      this.db.run("UPDATE costs SET status='unknown' WHERE status='reserved'");
      this.db.run(
        "UPDATE task_progress SET status='interrupted' WHERE status='running'",
      );
      this.db.run(
        "UPDATE media_jobs SET status=CASE WHEN remoteId != '' THEN 'detached' ELSE 'unknown' END,error='后台重启；保留提交记录，未自动重发' WHERE status IN ('submitting','polling','downloading')",
      );
    })();
  }
  board(projectId: string) {
    const plan = this.one<{ content: string }>(
      "SELECT a.content FROM artifacts a JOIN tasks t ON t.id=a.taskId WHERE t.projectId=? AND t.stage=1 AND a.revision=t.revision ORDER BY a.createdAt DESC LIMIT 1",
      projectId,
    );
    return {
      project: this.project(projectId),
      production: this.productionRules(projectId),
      planningCheckpoints: this.list(
        "SELECT p.* FROM planning_checkpoints p JOIN tasks t ON t.id=p.taskId WHERE t.projectId=? ORDER BY p.createdAt DESC",
        projectId,
      ),
      productionNeedsReplan:
        !!plan &&
        validateTextProduction(plan.content, 1, this.productionRules(projectId))
          .length > 0,
      progress: this.list(
        "SELECT p.* FROM task_progress p JOIN tasks t ON t.id=p.taskId WHERE t.projectId=?",
        projectId,
      ),
      mediaFiles: this.list(
        "SELECT * FROM media_files WHERE projectId=? ORDER BY createdAt DESC",
        projectId,
      ).map((f: any) => ({ ...f, path: undefined })),
      mediaJobs: this.list(
        "SELECT * FROM media_jobs WHERE projectId=? ORDER BY createdAt DESC",
        projectId,
      ),
      tasks: this.list<Task>(
        "SELECT * FROM tasks WHERE projectId=? ORDER BY stage",
        projectId,
      ),
      artifacts: this.list<Artifact>(
        "SELECT a.* FROM artifacts a JOIN tasks t ON t.id=a.taskId WHERE t.projectId=? ORDER BY a.createdAt DESC",
        projectId,
      ),
      events: this.list(
        "SELECT * FROM events WHERE projectId=? ORDER BY seq DESC LIMIT 150",
        projectId,
      ),
      interventions: this.list(
        "SELECT i.* FROM interventions i JOIN tasks t ON t.id=i.taskId WHERE t.projectId=? ORDER BY i.createdAt DESC",
        projectId,
      ),
      costs: this.list("SELECT * FROM costs WHERE projectId=?", projectId),
    };
  }
}

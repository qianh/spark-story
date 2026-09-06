import {
  stageOrder,
  globalStages,
  episodeStages,
  isMediaStage,
  rank,
  storySchema,
  seriesPlanSchema,
  structured,
  planIssues,
  storyIssues,
} from "../../packages/series";
import {
  assetPlanSchema,
  storyboardSchema,
  mediaBundle,
} from "../../packages/media";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { upgradeEpisodePlanning, upgradeSeriesWorkflow } from "./migrations";
import {
  productionRulesSchema,
  validateTextProduction,
  timingManifest,
  validateShotTiming,
  type ProductionRules,
} from "../../packages/production";
import {
  stages,
  templates,
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
    upgradeSeriesWorkflow(this, path);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS voice_library(projectId TEXT,character TEXT,connectionId TEXT,data TEXT,PRIMARY KEY(projectId,character,connectionId));
      CREATE TABLE IF NOT EXISTS episodes(projectId TEXT,number INTEGER,planRevision INTEGER,data TEXT,active INTEGER DEFAULT 1,PRIMARY KEY(projectId,number));
      CREATE TABLE IF NOT EXISTS asset_library(id TEXT PRIMARY KEY,projectId TEXT,assetId TEXT,version INTEGER,taskId TEXT,revision INTEGER,data TEXT,createdAt TEXT,UNIQUE(projectId,assetId,version));`);
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
      for (const stage of stageOrder)
        this.createTask(
          p.id,
          stage,
          globalStages.includes(stage) ? 0 : 1,
          stage === 0 ? "ready" : "blocked",
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
        "项目已创建。先确认概要与完整故事稿，再拆集；每集独立制作，共享已确认资产。",
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
        "SELECT * FROM tasks WHERE projectId=? AND stage=7",
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
  setVisualTemplate(projectId: string, templateId: string) {
    const style = templates.find((t) => t.id === templateId);
    if (!style) throw Error("未知视觉模板");
    this.project(projectId);
    return this.db.transaction(() => {
      if (this.project(projectId).template === templateId) return style;
      if (
        this.one(
          "SELECT id FROM tasks WHERE projectId=? AND status IN ('running','reviewing','coordinating')",
          projectId,
        )
      )
        throw Error("项目仍在执行，请先中断任务再修改画风");
      if (
        this.one(
          "SELECT id FROM media_jobs WHERE projectId=? AND status IN ('submitting','polling','downloading')",
          projectId,
        )
      )
        throw Error("媒体任务仍在执行，请先停止或等待完成");
      this.db.run("UPDATE projects SET template=? WHERE id=?", [
        templateId,
        projectId,
      ]);
      for (const t of this.tasks(projectId).filter((t) =>
        isMediaStage(t.stage),
      )) {
        this.db.run(
          "UPDATE tasks SET revision=revision+1,round=0,error='',updatedAt=? WHERE id=?",
          [now(), t.id],
        );
        const current = this.task(t.id);
        this.db.run("UPDATE tasks SET status=? WHERE id=?", [
          this.canRun(current) ? "ready" : "blocked",
          t.id,
        ]);
      }
      this.event(
        projectId,
        "",
        "visual.template",
        `画风已改为「${style.name}」。已有定妆图保留为旧版本；重新执行定妆后按新画风生成，不复刻任何现有动画角色。`,
      );
      return style;
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
      const issues = this.validateArtifact(t, a.content);
      if (issues.length) throw Error(issues.join("；"));
      this.db.run(
        "UPDATE artifacts SET status='superseded' WHERE taskId=? AND status='approved'",
        [taskId],
      );
      this.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [
        artifactId,
      ]);
      this.updateTask(taskId, revision, "approved");
      if (t.stage === 1) this.syncEpisodes(t, a.content);
      if (t.stage === 3) this.registerAssets(t, a.content);
      for (const next of this.tasks(t.projectId))
        if (next.status === "blocked" && this.canRun(next))
          this.updateTask(next.id, next.revision, "ready");
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
  repairChapter(
    taskId: string,
    revision: number,
    chapterId: string,
    instruction: string,
  ) {
    const t = this.task(taskId);
    if (t.stage !== 7 || t.revision !== revision)
      throw Error("章节任务或修订已变化");
    if (["running", "reviewing", "coordinating"].includes(t.status))
      throw Error("请先暂停故事任务，再提交章节修改");
    const structure = this.one<{ content: string }>(
      "SELECT content FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind='故事结构' AND status='reviewed' ORDER BY rowid DESC LIMIT 1",
      taskId,
      revision,
    );
    const chapters = structure ? JSON.parse(structure.content).chapters : [];
    const index = chapters.findIndex((c: any) => c.id === chapterId);
    if (index < 0) throw Error("未找到可局部修订的章节");
    this.db.transaction(() => {
      this.db.run(
        "UPDATE tasks SET revision=revision+1,round=0,status='paused',instruction=?,error='',updatedAt=? WHERE id=?",
        [
          `修改章节 ${chapterId}：${instruction}。其他故事事实与结构保留。`,
          now(),
          taskId,
        ],
      );
      const preserved = [
        "故事结构",
        ...chapters.slice(0, index).map((c: any) => `章节 ${c.id}`),
      ];
      for (const kind of preserved) {
        const cp = this.one<{ content: string }>(
          "SELECT content FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind=? AND status='reviewed' ORDER BY rowid DESC LIMIT 1",
          taskId,
          revision,
          kind,
        );
        if (cp)
          this.db.run(
            "INSERT INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)",
            [id(), taskId, revision + 1, kind, cp.content, "reviewed", now()],
          );
      }
      this.invalidateAfter(t);
      this.event(
        t.projectId,
        t.id,
        "story.repair",
        `已保存 ${chapterId} 修改要求；前 ${index} 章保留，本章与其后衔接章节将重新生成。点击开始执行继续。`,
      );
    })();
  }
  tasks(projectId: string) {
    const episodes = this.list<{ number: number; active: number }>(
      "SELECT number,active FROM episodes WHERE projectId=?",
      projectId,
    );
    const active = new Set(
      episodes.filter((e) => e.active).map((e) => e.number),
    );
    return this.list<Task>("SELECT * FROM tasks WHERE projectId=?", projectId)
      .filter((t) => !t.episode || !episodes.length || active.has(t.episode))
      .sort(
        (a, b) =>
          (a.episode || 0) - (b.episode || 0) || rank(a.stage) - rank(b.stage),
      );
  }
  createTask(
    projectId: string,
    stage: number,
    episode: number,
    status = "blocked",
  ) {
    this.db.run(
      "INSERT OR IGNORE INTO tasks(id,projectId,stage,title,role,status,updatedAt,episode) VALUES(?,?,?,?,?,?,?,?)",
      [
        id(),
        projectId,
        stage,
        stages[stage],
        [
          "剧情 Agent",
          "分集规划 Agent",
          "剧情 Agent",
          "角色与资产 Agent",
          "分镜 Agent",
          "视频 Agent",
          "后期 Agent",
          "故事 Agent",
          "分镜 Agent",
        ][stage],
        status,
        now(),
        episode,
      ],
    );
  }
  dependencies(task: Task) {
    return this.list<Task>(
      "SELECT * FROM tasks WHERE projectId=? AND (episode=0 OR episode=?)",
      task.projectId,
      task.episode || 0,
    )
      .sort((a, b) => rank(a.stage) - rank(b.stage))
      .filter(
        (t) =>
          t.id !== task.id &&
          (globalStages.includes(t.stage)
            ? rank(t.stage) < rank(task.stage)
            : !!task.episode &&
              t.episode === task.episode &&
              rank(t.stage) < rank(task.stage)),
      );
  }
  downstream(task: Task) {
    return this.tasks(task.projectId).filter(
      (t) =>
        rank(t.stage) > rank(task.stage) &&
        (globalStages.includes(task.stage) ||
          (t.episode === task.episode && !globalStages.includes(t.stage))),
    );
  }
  upstream(task: Task) {
    return this.dependencies(task).flatMap((t) =>
      this.list<Artifact>(
        "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='approved'",
        t.id,
        t.revision,
      ),
    );
  }
  invalidateAfter(task: Task) {
    for (const t of this.downstream(task))
      this.db.run(
        "UPDATE tasks SET revision=revision+1,round=0,status='blocked',error='上游已修改，等待重新确认',updatedAt=? WHERE id=?",
        [now(), t.id],
      );
    this.event(
      task.projectId,
      task.id,
      "plan.revised",
      "相关下游修订已失效；已有产物保留，其他集的独立制作不受本集修改影响。",
    );
  }
  canRun(task: Task) {
    if (
      task.episode &&
      !this.one(
        "SELECT number FROM episodes WHERE projectId=? AND number=? AND active=1",
        task.projectId,
        task.episode,
      )
    )
      return false;
    return this.dependencies(task).every((t) => t.status === "approved");
  }
  validateArtifact(task: Task, content: string) {
    if (task.stage === 7) {
      const story = structured(content, storySchema);
      return story
        ? storyIssues(story)
        : ["完整故事稿结构不完整，需包含章节正文和故事段落索引"];
    }
    if (task.stage === 1) {
      const plan = structured(content, seriesPlanSchema);
      const source = this.upstream(task).find(
        (a) => this.task(a.taskId).stage === 7,
      );
      const story = source && structured(source.content, storySchema);
      return plan && story
        ? planIssues(plan, story)
        : ["需要已确认完整故事稿和有效的轻量分集规划"];
    }
    if (task.stage === 8) {
      const bundle = mediaBundle(content);
      const parsed = storyboardSchema.safeParse(bundle?.data);
      const script = this.upstream(task).find(
        (a) => this.task(a.taskId).stage === 2,
      );
      return bundle?.type === "shot-plan" && parsed.success
        ? validateShotTiming(
            parsed.data.shots,
            this.productionRules(task.projectId),
            timingManifest(script?.content || "")?.episodes[0],
          )
        : ["文字分镜产物无效"];
    }
    if ([3, 4, 5, 6].includes(task.stage)) {
      const bundle = mediaBundle(content);
      if (
        !bundle ||
        bundle.type !==
          ["", "", "", "assets", "storyboard", "production", "timeline"][
            task.stage
          ]
      )
        return ["媒体产物类型不匹配"];
      if (task.stage === 3) {
        const parsed = assetPlanSchema.safeParse(bundle.data);
        if (!parsed.success) return ["资产清单结构无效"];
        if (
          new Set(parsed.data.assets.map((a) => a.id)).size !==
          parsed.data.assets.length
        )
          return ["资产 ID 重复"];
        for (const asset of parsed.data.assets) {
          if (
            !asset.imageId ||
            !this.one(
              "SELECT id FROM media_files WHERE id=? AND projectId=?",
              asset.imageId,
              task.projectId,
            )
          )
            return ["资产图片不存在或不属于本作品"];
          if (asset.libraryId) {
            const saved = this.assetLibrary(task.projectId).find(
              (a) => a.libraryId === asset.libraryId,
            );
            if (
              !saved ||
              saved.imageId !== asset.imageId ||
              saved.identity !== asset.identity ||
              saved.state !== asset.state
            )
              return ["复用的资产版本发生变化，请创建新版本"];
          }
        }
        return [];
      }
      const parsed = storyboardSchema.safeParse(bundle.data);
      const script = this.upstream(task).find(
        (a) => this.task(a.taskId).stage === 2,
      );
      return parsed.success
        ? validateShotTiming(
            parsed.data.shots,
            this.productionRules(task.projectId),
            timingManifest(script?.content || "")?.episodes[0],
          )
        : ["镜头清单结构无效"];
    }
    const issues = validateTextProduction(
      content,
      task.stage,
      this.productionRules(task.projectId),
      task.episode || 1,
    );
    if (
      task.stage === 2 &&
      JSON.stringify(timingManifest(content)?.episodes[0]?.sourceStepIds) !==
        JSON.stringify(this.episodePlan(task)?.sourceBeatIds)
    )
      issues.push("剧本越过本集已确认来源边界");
    return issues;
  }
  syncEpisodes(task: Task, content: string) {
    const plan = seriesPlanSchema.parse(JSON.parse(content));
    this.db.run("UPDATE episodes SET active=0 WHERE projectId=?", [
      task.projectId,
    ]);
    plan.episodes.forEach((ep, i) => {
      this.db.run(
        "INSERT INTO episodes VALUES(?,?,?,?,1) ON CONFLICT(projectId,number) DO UPDATE SET planRevision=excluded.planRevision,data=excluded.data,active=1",
        [task.projectId, i + 1, task.revision, JSON.stringify(ep)],
      );
      for (const stage of episodeStages)
        this.createTask(task.projectId, stage, i + 1);
    });
  }
  episodePlan(task: Task) {
    const row = this.one<{ data: string }>(
      "SELECT data FROM episodes WHERE projectId=? AND number=? AND active=1",
      task.projectId,
      task.episode || 1,
    );
    return row ? JSON.parse(row.data) : null;
  }
  assetLibrary(projectId: string) {
    return this.list<{ id: string; data: string; version: number }>(
      "SELECT * FROM asset_library WHERE projectId=? ORDER BY createdAt DESC",
      projectId,
    ).map((r) => ({
      ...JSON.parse(r.data),
      libraryId: r.id,
      version: r.version,
    }));
  }
  approvedVoices(projectId: string, connectionId: string) {
    return this.list<{ data: string }>(
      "SELECT data FROM voice_library WHERE projectId=? AND connectionId=?",
      projectId,
      connectionId,
    ).map((r) => JSON.parse(r.data));
  }
  registerAssets(task: Task, content: string) {
    const bundle = mediaBundle(content);
    const parsed = assetPlanSchema.parse(bundle?.data);
    const assets = parsed.assets;
    const binding = this.one<{ connectionId: string }>(
      "SELECT connectionId FROM bindings WHERE role='语音模型'",
    );
    const seen = new Set<string>();
    if (binding)
      for (const voice of parsed.voices) {
        if (seen.has(voice.character)) continue;
        seen.add(voice.character);
        this.db.run(
          "INSERT INTO voice_library VALUES(?,?,?,?) ON CONFLICT(projectId,character,connectionId) DO UPDATE SET data=excluded.data",
          [
            task.projectId,
            voice.character,
            binding.connectionId,
            JSON.stringify(voice),
          ],
        );
      }
    for (const asset of assets) {
      if (asset.libraryId) continue;
      const version =
        (this.one<{ n: number }>(
          "SELECT MAX(version) AS n FROM asset_library WHERE projectId=? AND assetId=?",
          task.projectId,
          asset.id,
        )?.n || 0) + 1;
      this.db.run("INSERT INTO asset_library VALUES(?,?,?,?,?,?,?,?)", [
        id(),
        task.projectId,
        asset.id,
        version,
        task.id,
        task.revision,
        JSON.stringify(asset),
        now(),
      ]);
    }
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
        for (const cp of this.list<{
          kind: string;
          content: string;
          status: string;
        }>(
          "SELECT kind,content,status FROM planning_checkpoints WHERE taskId=? AND revision=? ORDER BY rowid",
          t.id,
          t.revision,
        ))
          this.db.run(
            "INSERT INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)",
            [id(), t.id, t.revision + 1, cp.kind, cp.content, cp.status, now()],
          );
        if ([3, 4, 5, 6].includes(t.stage)) {
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
        !!plan && !structured(plan.content, seriesPlanSchema),
      episodes: this.list(
        "SELECT * FROM episodes WHERE projectId=? AND active=1 ORDER BY number",
        projectId,
      ).map((r: any) => ({ ...r, ...JSON.parse(r.data), data: undefined })),
      assetLibrary: this.assetLibrary(projectId),
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
      tasks: this.tasks(projectId),
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

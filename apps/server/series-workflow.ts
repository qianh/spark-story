import { produceShotPlan } from "./shot-workflow";
import { z } from "zod";
import type { Runtime } from "./runtime";
import type { Task, Artifact, Connection } from "../../packages/domain";
import { reviewSchema } from "../../packages/domain";
import { parseResult } from "./connectors";
import {
  storyOutlineSchema,
  chapterSchema,
  storySchema,
  seriesPlanSchema,
  structured,
  storyIssues,
  planIssues,
} from "../../packages/series";
import {
  lookRegistrySchema,
  lookRegistryAgentPrompt,
} from "../../packages/look-registry";
import {
  timingManifest,
  validateTextProduction,
} from "../../packages/production";

export async function executeSeries(
  runtime: Runtime,
  task: Task,
  attempt: string,
  text: Connection,
  master: Connection,
  upstream: Artifact[],
  signal: AbortSignal,
) {
  const { store } = runtime;
  const current = () => {
    if (signal.aborted || store.task(task.id).revision !== task.revision)
      throw Error("任务已中断");
  };
  const rules = store.productionRules(task.projectId);
  const save = (kind: string, content: string, status: string) => {
    current();
    store.db.run("INSERT INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)", [
      crypto.randomUUID(),
      task.id,
      task.revision,
      kind,
      content,
      status,
      new Date().toISOString(),
    ]);
  };
  // Each checkpoint is scoped to its input revision. Provider errors leave candidates available for review.
  async function part<T>(
    kind: string,
    schema: z.ZodType<T>,
    prompt: string,
    validate: (data: T) => string[] = () => [],
  ): Promise<T> {
    const cp = store.one<{ content: string; status: string }>(
      "SELECT content,status FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind=? ORDER BY rowid DESC LIMIT 1",
      task.id,
      task.revision,
      kind,
    );
    if (cp?.status === "reviewed") return schema.parse(JSON.parse(cp.content));
    let feedback =
      cp?.status === "rejected" ? "上次片段未通过，请修复该片段。" : "";
    let previous = cp?.content || "";
    const failures = store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind=? AND status='rejected'",
      task.id,
      task.revision,
      kind,
    )!.n;
    for (let n = failures; n < 3; n++) {
      current();
      store.updateTask(task.id, task.revision, "running");
      store.event(
        task.projectId,
        task.id,
        "workflow.part",
        `${kind} · ${n ? "局部修复" : "生成/恢复"}；已确认片段保留`,
      );
      const raw =
        n === failures && cp?.status === "candidate"
          ? cp.content
          : await runtime.call(
              task,
              attempt,
              text,
              `${prompt}\n用户要求：${task.instruction}\n${feedback ? `仅修复当前片段：${feedback}\n上一版：${previous}` : ""}`,
              signal,
            );
      current();
      let data: T;
      try {
        data = schema.parse(parseResult(raw));
        const issues = validate(data);
        if (issues.length) throw Error(issues.slice(0, 20).join("；"));
      } catch (e) {
        feedback = `格式/内容检查失败：${String(e).slice(0, 3000)}。如果输出截断，缩短当前片段，完整关闭 JSON；不要声称省略内容已生成。`;
        previous = raw.slice(0, 28000);
        save(kind, previous, "rejected");
        store.event(
          task.projectId,
          task.id,
          "workflow.part.failed",
          `${kind}：${feedback}`,
        );
        continue;
      }
      const serialized = JSON.stringify(data);
      save(kind, serialized, "candidate");
      store.updateTask(task.id, task.revision, "reviewing");
      const report = reviewSchema.parse(
        parseResult(
          await runtime.call(
            task,
            attempt,
            master,
            `你是主控。仅审核当前片段，检查任务落实、人物动机、因果、来源忠实性及前后衔接。场景数、反应比例、钩子模板是建议，不是硬性退回理由。只返回 JSON {"pass":boolean,"feedback":"通过理由或定位到当前片段的可执行问题"}。\n任务：${prompt}\n产物：${serialized}`,
            signal,
          ),
        ),
      );
      current();
      save(kind, serialized, report.pass ? "reviewed" : "rejected");
      store.event(
        task.projectId,
        task.id,
        report.pass ? "workflow.part.passed" : "workflow.part.failed",
        `${kind}：${report.feedback}`,
      );
      if (report.pass) return data;
      feedback = report.feedback;
      previous = serialized;
    }
    throw Error(
      `制作验收：${kind} 连续修复仍未通过，已暂停；已通过片段保留，请提交明确修改意见。`,
    );
  }
  const outline =
    upstream.find((a) => store.task(a.taskId).stage === 0)?.content || "";
  const storySource =
    upstream.find((a) => store.task(a.taskId).stage === 7)?.content || "";
  const story = structured(storySource, storySchema);
  const edited = store.one<Artifact>(
    "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='candidate' ORDER BY rowid DESC LIMIT 1",
    task.id,
    task.revision,
  );
  let content = "";
  if (edited) {
    const issues = store.validateArtifact(task, edited.content);
    if (issues.length) throw Error(`制作验收：${issues.join("；")}`);
    content = edited.content;
  } else if (task.stage === 7) {
    const structure = await part(
      "故事结构",
      storyOutlineSchema,
      `你是故事 Agent。依据已确认概要，规划覆盖开端、发展、高潮和结局的章节结构，以及人物、时间线、世界规则和伏笔设定。暂不拆集，不写秒数和镜头。每章是可在 24000 字符以内完整展开的故事段落，不为凑章数注水。只返回 JSON {"bible":"全剧设定与人物变化、伏笔回收约定","chapters":[{"id":"CH001","title":"标题","synopsis":"这一章具体经历、变化和与后章的因果连接"}]}。\n已确认概要：${outline}`,
      (d) =>
        new Set(d.chapters.map((c) => c.id)).size !== d.chapters.length
          ? ["章节 ID 重复"]
          : [],
    );
    const chapters: z.infer<typeof chapterSchema>[] = [];
    for (const c of structure.chapters) {
      const chapter = await part(
        `章节 ${c.id}`,
        chapterSchema,
        `你是故事 Agent。把当前章写成完整小说化/剧情化正文，完整呈现经过、人物动机、对话、行动、反应与后果，不能交付概要或情节清单。不写镜头、集数、精确秒数。正文建议 1500～6000 汉字，最多 24000 字符。另列正文中连续发生的具体故事段落 beats，作为以后拆集的引用，每段应是可独立定位的短场面或行动变化；一个事件可含多段，eventId 可跨章延续，段落 id 用 ${c.id}-B001 等前缀。只返回 JSON {"id":"${c.id}","title":"标题","content":"完整章节正文","continuity":"本章结束的人物位置、关系、知识、道具状态及未回收伏笔","beats":[{"id":"${c.id}-B001","eventId":"E001","description":"对应正文的具体经历与变化"}]}。\n全剧结构：${JSON.stringify(structure)}\n当前章：${JSON.stringify(c)}\n前章衔接：${JSON.stringify(chapters.map((p) => ({ id: p.id, continuity: p.continuity })))}\n前章末段：${chapters.at(-1)?.content.slice(-3500) || "故事开始"}`,
        (d) =>
          d.id !== c.id
            ? ["章节 ID 不匹配"]
            : d.beats.some((b) => !b.id.startsWith(c.id + "-"))
              ? ["段落 ID 缺少章节前缀"]
              : [],
      );
      chapters.push(chapter);
    }
    const lookRegistry = await part(
      "外观登记",
      lookRegistrySchema,
      lookRegistryAgentPrompt(
        structure.bible,
        JSON.stringify(
          chapters.map((c) => ({
            id: c.id,
            title: c.title,
            continuity: c.continuity,
            beats: c.beats,
          })),
        ),
      ),
      (d) =>
        d.entities.some((e) => new Set(e.variants.map((v) => v.id)).size !== e.variants.length)
          ? ["变体 ID 重复"]
          : [],
    );
    const result = storySchema.parse({
      type: "story",
      bible: structure.bible,
      chapters,
      lookRegistry,
    });
    const issues = storyIssues(result);
    if (issues.length) throw Error(`制作验收：${issues.join("；")}`);
    content = JSON.stringify(result);
  } else if (task.stage === 1) {
    if (!story) throw Error("制作验收：先确认完整故事稿");
    const result = await part(
      "全剧分集边界",
      seriesPlanSchema,
      `你是分集规划 Agent。只依据已确认完整故事拆集，不重写全剧，不提前写逐集对白、performance 或精确节拍。按故事事件、人物变化与自然断点规划，每集目标 ${rules.minSeconds}～${rules.maxSeconds} 秒。事件与集是多对多：一个事件可跨集，一集可承接多个相关事件。sourceBeatIds 按正文顺序完整覆盖所有段落且不重复；短小相关段落可合并，结尾可以悬念或收束，不套固定六步模板。计时是粗估，说明表演依据；不可只按字数分配。只返回紧凑 JSON {"type":"series-plan","rationale":"拆分理由","episodes":[{"id":"EP001","title":"标题","sourceBeatIds":["CH001-B001"],"summary":"本集具体故事经过","opening":"开始状态","ending":"结束边界与后集承接","change":"人物或局势变化","estimatedSeconds":105,"timingReason":"对白、动作和事件量的粗估依据"}]}。每集描述简洁，总输出不得超过 60000 字符。\n设定：${story.bible}\n已确认故事段落：${JSON.stringify(story.chapters.map((c) => ({ id: c.id, title: c.title, continuity: c.continuity, beats: c.beats })))}`,
      (d) => planIssues(d, story),
    );
    content = JSON.stringify(result);
  } else if (task.stage === 2) {
    const ep = store.episodePlan(task);
    if (!ep || !story) throw Error("制作验收：缺少已确认故事与本集边界");
    const selected = story.chapters.filter((c) =>
      c.beats.some((b) => ep.sourceBeatIds.includes(b.id)),
    );
    const schema = z.object({ content: z.string().min(1) });
    const result = await part(
      `单集剧本 ${ep.id}`,
      schema,
      `你是单集剧情 Agent。细化 ${ep.id}，保持已确认故事事实及本集起止边界，只丰富表演细节，不偷用后续剧情。输出中文 Markdown 分场剧本，完整动作、对白和必要反应。末尾唯一 production-json 代码块，格式 {"episodes":[{"id":"${ep.id}","duration":105,"sourceStepIds":${JSON.stringify(ep.sourceBeatIds)},"beats":[{"id":"${ep.id}-B001","start":0,"end":20,"purpose":"setup","information":"具体信息","change":"变化","exitState":"状态","sceneId":"地点ID","performance":{"dialogue":[{"speaker":"人物","text":"实际完整台词"}],"actions":[{"description":"可演动作","seconds":5,"overlapSpeech":false}],"reaction":{"description":"具体反应","seconds":2},"transitionSeconds":0}}]}]}。示例不是完整交付，节拍连续覆盖 duration，总时长 ${rules.minSeconds}～${rules.maxSeconds} 秒。purpose 可为 hook/setup/conflict/turn/payoff/cliffhanger/closure，按剧情选择，不强制模板或反应比例。sourceStepIds 必须与本集 sourceBeatIds 完全一致；如容量不适合，说明边界需要调整而非篡改事件。只返回 JSON {"content":"上述完整 Markdown 含时间清单"}。\n本集：${JSON.stringify(ep)}\n全剧设定：${story.bible}\n本集来源章节（仅演已分配段落）：${JSON.stringify(selected)}`,
      (d) => {
        const issues = validateTextProduction(
          d.content,
          2,
          rules,
          task.episode || 1,
        );
        if (
          JSON.stringify(
            timingManifest(d.content)?.episodes[0]?.sourceStepIds,
          ) !== JSON.stringify(ep.sourceBeatIds)
        )
          issues.push("剧本越过本集已确认来源边界");
        return issues;
      },
    );
    content = result.content;
  } else if (task.stage === 8) {
    const script =
      upstream.find((a) => store.task(a.taskId).stage === 2)?.content || "";
    const board = await produceShotPlan(
      runtime,
      task,
      attempt,
      text,
      master,
      script,
      signal,
    );
    content = JSON.stringify({ type: "shot-plan", data: board });
  }
  current();
  const finalIssues = store.validateArtifact(task, content);
  if (finalIssues.length) throw Error(`制作验收：${finalIssues.join("；")}`);
  const artifact = edited || store.publish(task.id, task.revision, content);
  store.updateTask(task.id, task.revision, "reviewing");
  const data = structured(content, storySchema);
  if (edited && data) {
    for (const chapter of data.chapters) {
      current();
      const kind = `章节 ${chapter.id}`;
      const serialized = JSON.stringify(chapter);
      const checkpoint = store.one<{ content: string; status: string }>(
        "SELECT content,status FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind=? ORDER BY rowid DESC LIMIT 1",
        task.id,
        task.revision,
        kind,
      );
      if (
        checkpoint?.status === "reviewed" &&
        checkpoint.content === serialized
      )
        continue;
      const report = reviewSchema.parse(
        parseResult(
          await runtime.call(
            task,
            attempt,
            master,
            `你是主控。审核用户直接编辑的章节正文，检查人物动机、因果、来源忠实性，以及正文与段落索引、衔接记录是否一致。只返回 JSON {"pass":boolean,"feedback":"通过理由或定位到当前章节的可执行问题"}。\n用户要求：${task.instruction}\n已确认概要：${outline}\n全剧设定：${data.bible}\n产物：${serialized}`,
            signal,
          ),
        ),
      );
      current();
      save(kind, serialized, report.pass ? "reviewed" : "rejected");
      store.event(
        task.projectId,
        task.id,
        report.pass ? "workflow.part.passed" : "workflow.part.failed",
        `${kind}：${report.feedback}`,
      );
      if (!report.pass) {
        store.db.run("UPDATE artifacts SET status='rejected' WHERE id=?", [
          artifact.id,
        ]);
        store.updateTask(
          task.id,
          task.revision,
          "needs_user",
          `${kind} 审核未通过：${report.feedback}`,
        );
        store.db.run("UPDATE attempts SET status='completed' WHERE id=?", [
          attempt,
        ]);
        return;
      }
    }
  }
  // Final cross-part review uses continuity records; individual chapter prose was already reviewed.
  const context = data
    ? JSON.stringify({
        bible: data.bible,
        chapters: data.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          continuity: c.continuity,
          beats: c.beats,
        })),
      })
    : content;
  const final = reviewSchema.parse(
    parseResult(
      await runtime.call(
        task,
        attempt,
        master,
        `你是主控。审核 ${task.title} 的整体衔接、事实一致与交付完整性。${task.stage === 8 ? "文字分镜已完成来源约束、逐镜头及补丁相邻衔接审核；本次仅核对全片开始到结束的衔接和交付完整性，不重复逐字段审核。审美建议不阻断；只有明确且可定位的矛盾才退回，并一次列全，不能依据推测增加年龄等设定。" : ""}章节正文已分别审核时，此处核对全剧因果、时间线和伏笔。不能强制统一钩子模板、场景数量或反应比例。失败请定位章节/集/镜头并说明原因；不要建议全剧重写。返回 JSON {"pass":boolean,"feedback":"理由"}。\n用户要求：${task.instruction}\n已确认概要：${outline}\n产物：${context}`,
        signal,
      ),
    ),
  );
  current();
  store.db.run("UPDATE artifacts SET status=? WHERE id=?", [
    final.pass ? "reviewed" : "rejected",
    artifact.id,
  ]);
  store.event(
    task.projectId,
    task.id,
    final.pass ? "review.passed" : "review.failed",
    final.feedback,
  );
  if (final.pass) {
    store.invalidateAfter(task);
    store.updateTask(task.id, task.revision, "awaiting_user");
  } else
    store.updateTask(
      task.id,
      task.revision,
      "needs_user",
      `整体审核未通过，已保留各片段：${final.feedback}`,
    );
  store.db.run("UPDATE attempts SET status='completed' WHERE id=?", [attempt]);
}

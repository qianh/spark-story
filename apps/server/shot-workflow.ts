import { z } from "zod";
import type { Runtime } from "./runtime";
import type { Task, Connection } from "../../packages/domain";
import {
  storyboardSchema,
  shotSchema,
  type Storyboard,
} from "../../packages/media";
import { timingManifest, validateShotTiming } from "../../packages/production";
import { parseResult } from "./connectors";

class ProviderCallError extends Error {}

export const constraintsSchema = z.object({
  facts: z
    .array(z.object({ evidence: z.string().min(1), rule: z.string().min(1) }))
    .max(40),
});
export const shotReviewSchema = z.object({
  issues: z
    .array(
      z.object({
        shotId: z.string().min(1),
        field: z.enum([
          "prompt",
          "imagePrompt",
          "motionPrompt",
          "camera",
          "startState",
          "endState",
          "assetIds",
          "dialogue",
          "speaker",
          "duration",
          "beatId",
          "sceneId",
        ]),
        severity: z.enum(["blocking", "suggestion"]),
        evidence: z.string(),
        reason: z.string().min(1),
        fix: z.string().min(1),
      }),
    )
    .max(100),
});
export function mergeShotPatch(
  board: Storyboard,
  raw: unknown,
  allowed: string[],
) {
  const patch = z
    .object({ shots: z.array(shotSchema).min(1) })
    .strict()
    .parse(raw);
  const ids = patch.shots.map((s) => s.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) => !allowed.includes(id) || !board.shots.some((s) => s.id === id),
    )
  )
    throw Error("补丁包含重复、未知或未授权镜头");
  if (allowed.some((id) => !ids.includes(id)))
    throw Error("补丁遗漏要求修复的镜头");
  return storyboardSchema.parse({
    ...board,
    shots: board.shots.map((s) => patch.shots.find((p) => p.id === s.id) || s),
  });
}
export function reviewWindow(board: Storyboard, ids: string[]) {
  return board.shots.filter(
    (s, i, shots) =>
      ids.includes(s.id) ||
      ids.includes(shots[i - 1]?.id || "") ||
      ids.includes(shots[i + 1]?.id || ""),
  );
}

export async function produceShotPlan(
  runtime: Runtime,
  task: Task,
  attempt: string,
  text: Connection,
  master: Connection,
  script: string,
  signal: AbortSignal,
) {
  const { store } = runtime;
  const ep = `EP${String(task.episode || 1).padStart(3, "0")}`;
  const kind = `文字分镜 ${ep}`;
  const rules = store.productionRules(task.projectId);
  const timing = timingManifest(script)?.episodes[0];
  const current = () => {
    if (signal.aborted || store.task(task.id).revision !== task.revision)
      throw Error("任务已中断");
  };
  const save = (name: string, data: unknown, status: string) => {
    current();
    store.db.run("INSERT INTO planning_checkpoints VALUES(?,?,?,?,?,?,?)", [
      crypto.randomUUID(),
      task.id,
      task.revision,
      name,
      JSON.stringify(data),
      status,
      new Date().toISOString(),
    ]);
  };
  const latest = (name: string) =>
    store.one<{ content: string; status: string }>(
      "SELECT content,status FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind=? ORDER BY rowid DESC LIMIT 1",
      task.id,
      task.revision,
      name,
    );
  const call = async (
    connection: Connection,
    prompt: string,
    phase: string,
  ) => {
    current();
    store.updateTask(
      task.id,
      task.revision,
      phase === "审核" ? "reviewing" : "running",
    );
    store.event(task.projectId, task.id, "workflow.part", `${kind} · ${phase}`);
    const start = Date.now();
    let result: string;
    try {
      result = await runtime.call(task, attempt, connection, prompt, signal);
    } catch (error) {
      throw new ProviderCallError(String(error));
    }
    current();
    store.event(
      task.projectId,
      task.id,
      "workflow.metrics",
      `${kind} · ${phase}耗时 ${Math.round((Date.now() - start) / 1000)} 秒，返回 ${result.length} 字符`,
    );
    return parseResult(result);
  };
  const cp = latest(kind);
  if (cp?.status === "reviewed")
    return storyboardSchema.parse(JSON.parse(cp.content));
  const failures = store.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM planning_checkpoints WHERE taskId=? AND revision=? AND kind=? AND status='rejected'",
    task.id,
    task.revision,
    kind,
  )!.n;
  if (failures >= 3)
    throw Error(`制作验收：${kind} 已达到 3 次尝试上限，请提交明确修改意见。`);
  let constraints: z.infer<typeof constraintsSchema>;
  const savedConstraints = latest(`分镜约束 ${ep}`);
  if (savedConstraints)
    constraints = constraintsSchema.parse(JSON.parse(savedConstraints.content));
  else {
    constraints = constraintsSchema.parse(
      await call(
        text,
        `你是分镜约束提取 Agent。只提取已确认剧本中明确的人物身份、持续携带/怀抱关系、道具状态及其变化、不可提前揭示的信息。每条 evidence 必须是剧本逐字原文，rule 不增加事实。未知年龄等不得补成精确设定；不要根据年龄推断说话能力。最多 40 条简洁规则。返回 JSON {"facts":[{"evidence":"原文","rule":"约束"}]}。\n剧本：${script}`,
        "提取共用约束",
      ),
    );
    if (constraints.facts.some((f) => !script.includes(f.evidence)))
      throw Error("制作验收：分镜约束引用不属于剧本原文");
    save(`分镜约束 ${ep}`, constraints, "candidate");
  }
  const context = `用户要求：${task.instruction}\n已确认剧本：${script}\n共用约束（仍须对照原文，不得将推测作为事实）：${JSON.stringify(constraints)}\n未知设定不得擅自具体化。不要调用工具或修改文件，只返回要求的 JSON。`;
  const check = (board: Storyboard) => {
    const issues = validateShotTiming(board.shots, rules, timing);
    for (const s of board.shots) {
      for (const field of [
        "imagePrompt",
        "motionPrompt",
        "camera",
        "startState",
        "endState",
      ] as const)
        if (!s[field].trim()) issues.push(`${s.id} 缺少 ${field}`);
      if (s.imageId || s.audioId || s.videoId)
        issues.push(`${s.id} 文字分镜不能指定生成媒体 ID`);
      if (new Set(s.assetIds).size !== s.assetIds.length)
        issues.push(`${s.id} 资产引用重复`);
    }
    return issues;
  };
  let board: Storyboard | undefined;
  if (cp) {
    try {
      board = storyboardSchema.parse(JSON.parse(cp.content));
    } catch {}
  }
  let report = latest(`分镜审核 ${ep}`);
  let issues = report
    ? shotReviewSchema.parse(JSON.parse(report.content)).issues
    : [];
  let feedback = "";
  let rawCandidate: unknown = cp ? JSON.parse(cp.content) : {};
  for (let round = failures; round < 3; round++) {
    current();
    const blocking = issues.filter((i) => i.severity === "blocking");
    const allowed = [...new Set(blocking.map((i) => i.shotId))];
    let changed: string[] = [];
    try {
      if (!(round === failures && cp?.status === "candidate" && board)) {
        if (board && allowed.length) {
          const patch = await call(
            text,
            `你是分镜修复 Agent。只返回要求修改的镜头完整对象 {"shots":[...]}，禁止返回其他镜头、修改镜头 ID、增删或排序；未修改镜头由程序保留。一次修复全部 blocking 问题，suggestion 不要求修改。\n问题：${JSON.stringify(blocking)}\n目标与相邻镜头：${JSON.stringify(reviewWindow(board, allowed))}\n上次补丁检查：${feedback}\n${context}`,
            `镜头补丁 ${round + 1}/3 · ${allowed.join("、")}`,
          );
          board = mergeShotPatch(board, patch, allowed);
          changed = allowed;
        } else {
          board = storyboardSchema.parse(
            (rawCandidate = await call(
              text,
              `你是分镜 Agent。把本集完整拆成文字分镜，不生成媒体。返回 {"summary":"说明","shots":[{"id":"SH001","title":"标题","prompt":"摘要","beatId":"节拍ID","sceneId":"地点ID","duration":5,"assetIds":["稳定资产ID"],"imagePrompt":"静态画面","motionPrompt":"动作","camera":"景别机位","startState":"起始状态","endState":"结束状态","dialogue":"原文台词或空","speaker":"人物或空","route":"separate"}]}。镜头按节拍排列，时长与剧本一致，画面人物及持续怀抱/携带的角色道具必须列入 assetIds。\n检查反馈：${feedback}\n可复用资产：${JSON.stringify(store.assetLibrary(task.projectId).map((a) => ({ id: a.id, name: a.name, identity: a.identity, state: a.state })))}\n${context}`,
              `生成 ${round + 1}/3`,
            )),
          );
        }
      }
      const errors = check(board!);
      if (errors.length) throw Error(errors.join("；"));
    } catch (error) {
      current();
      // Provider errors must remain resumable and must not consume repair attempts.
      if (error instanceof ProviderCallError) throw error;
      feedback = String(error);
      save(kind, board || rawCandidate, "rejected");
      if (board && !allowed.length) {
        const targets = board.shots.filter((s) => feedback.includes(s.id));
        issues = (targets.length ? targets : board.shots).map((s) => ({
          shotId: s.id,
          field: "prompt" as const,
          severity: "blocking" as const,
          evidence: "",
          reason: feedback,
          fix: "修复程序检查问题，保留其他字段",
        }));
        save(`分镜审核 ${ep}`, { issues }, "reviewed");
      }
      store.event(
        task.projectId,
        task.id,
        "workflow.part.failed",
        `${kind}：程序检查：${feedback}`,
      );
      continue;
    }
    save(kind, board, "candidate");
    const window = changed.length
      ? reviewWindow(board!, changed)
      : board!.shots;
    const reviewed = shotReviewSchema.parse(
      await call(
        master,
        `你是主控。一次列全当前审核范围内的问题，每条给出镜头、字段、剧本原文依据和具体修改要求。仅明确来源冲突、时序矛盾、缺失画中人物/持续携带资产等阻断制作的问题标 blocking；审美偏好或无来源证据的推测标 suggestion，不能强制年龄与语言能力关联。不得因风格偏好退回。返回 {"issues":[{"shotId":"SH001","field":"startState","severity":"blocking或suggestion","evidence":"剧本逐字原文","reason":"问题","fix":"修改要求"}]}，无问题返回空数组。\n${changed.length ? "已通过的其他镜头由程序保留；本轮重点核对补丁与相邻衔接，不重新提出无关镜头的偏好。" : "核对所有镜头、全部约束和资产引用，一次列全，不分轮挑问题。"}\n上轮问题：${JSON.stringify(issues)}\n审核范围：${JSON.stringify(window)}\n${context}`,
        "审核",
      ),
    );
    for (const issue of reviewed.issues) {
      if (!window.some((s) => s.id === issue.shotId))
        throw Error("制作验收：审核引用了范围外镜头");
      if (
        issue.severity === "blocking" &&
        (!issue.evidence.trim() || !script.includes(issue.evidence))
      )
        throw Error("制作验收：阻断问题缺少有效剧本原文依据");
    }
    const introduced = changed.length
      ? reviewed.issues.filter(
          (i) =>
            i.severity === "blocking" &&
            !issues.some(
              (old) => old.shotId === i.shotId && old.field === i.field,
            ),
        ).length
      : 0;
    issues = reviewed.issues;
    save(`分镜审核 ${ep}`, reviewed, "reviewed");
    const passed = !issues.some((i) => i.severity === "blocking");
    save(kind, board, passed ? "reviewed" : "rejected");
    store.event(
      task.projectId,
      task.id,
      "workflow.metrics",
      `${kind} · 第 ${round + 1} 次${passed ? "通过" : "退回"}；本轮新增阻断项 ${introduced}；修改镜头 ${changed.length}`,
    );
    store.event(
      task.projectId,
      task.id,
      passed ? "workflow.part.passed" : "workflow.part.failed",
      `${kind}：${issues.length ? issues.map((i) => `${i.shotId}/${i.field} [${i.severity === "blocking" ? "必须修改" : "建议"}] ${i.reason}；依据：${i.evidence}；修改：${i.fix}`).join("\n") : "全部检查通过"}`,
    );
    if (passed) return board!;
  }
  throw Error(`制作验收：${kind} 3 次尝试未通过，已保留方案与审核意见。`);
}

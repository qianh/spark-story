import { z } from "zod";
import type { EpisodeTiming, ProductionRules } from "./production";

// Editable production defaults, not universal industry measurements.
export const capacityRulesSchema = z.object({
  speechUnitsPerSecond: z.number().min(2).max(5).default(3.5),
  maxScenes: z.number().int().min(1).max(4).default(2),
  maxNewCharacters: z.number().int().min(0).max(5).default(2),
  maxNewRules: z.number().int().min(0).max(3).default(1),
  maxMajorChanges: z.number().int().min(1).max(3).default(1),
  minReactionRatio: z.number().min(0.05).max(0.3).default(0.12),
  reserveRatio: z.number().min(0.05).max(0.2).default(0.1),
  maxSlackRatio: z.number().min(0.2).max(0.4).default(0.25),
});
export const performanceSchema = z.object({
  dialogue: z.array(
    z.object({ speaker: z.string().min(1), text: z.string().min(1) }),
  ),
  actions: z.array(
    z.object({
      description: z.string().min(1),
      seconds: z.number().positive().max(600),
      overlapSpeech: z.boolean(),
    }),
  ),
  reaction: z.object({
    description: z.string().min(1),
    seconds: z.number().nonnegative().max(120),
  }),
  transitionSeconds: z.number().nonnegative().max(15),
});
export const inventorySchema = z
  .object({
    units: z
      .array(
        z.object({
          id: z.string().min(1),
          arc: z.string().min(1),
          sourceAnchor: z.string().min(1),
          description: z.string().min(1),
          dramaticQuestion: z.string().min(1),
          steps: z
            .array(
              z.object({
                id: z.string().min(1),
                description: z.string().min(1),
                kind: z.enum([
                  "setup",
                  "pressure",
                  "choice",
                  "consequence",
                  "reaction",
                  "milestone",
                ]),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  })
  .superRefine((v, c) => {
    const ids = new Set<string>();
    for (const u of v.units)
      for (const id of [u.id, ...u.steps.map((s) => s.id)]) {
        if (ids.has(id))
          c.addIssue({ code: "custom", message: `情节 ID 重复：${id}` });
        ids.add(id);
      }
  });
export type StoryInventory = z.infer<typeof inventorySchema>;
export type Performance = z.infer<typeof performanceSchema>;
export const capacityRules = (r: ProductionRules) =>
  capacityRulesSchema.parse(r.capacity || {});
export function speechUnits(text: string) {
  // Chinese characters/digits count individually; Latin words are weighted estimates.
  return (
    (text.match(/[\p{Script=Han}\d]/gu) || []).length +
    (text.match(/[a-zA-Z]+/g) || []).length * 2.5
  );
}
export function performanceSeconds(
  p: Performance,
  r: z.infer<typeof capacityRulesSchema>,
) {
  const speech =
    p.dialogue.reduce(
      (s, d) =>
        s +
        speechUnits(d.text) / r.speechUnitsPerSecond +
        (d.text.match(/[，,、；;：:]/g) || []).length * 0.2 +
        (d.text.match(/[。！？.!?…]/g) || []).length * 0.4,
      0,
    ) +
    Math.max(0, p.dialogue.length - 1) * 0.35;
  const serial = p.actions
    .filter((a) => !a.overlapSpeech)
    .reduce((s, a) => s + a.seconds, 0);
  const parallel = p.actions
    .filter((a) => a.overlapSpeech)
    .reduce((s, a) => s + a.seconds, 0);
  return {
    speech,
    action: serial + parallel,
    reaction: p.reaction.seconds,
    transition: p.transitionSeconds,
    total:
      serial +
      Math.max(speech, parallel) +
      p.reaction.seconds +
      p.transitionSeconds,
  };
}
export function capacityAudit(ep: EpisodeTiming, rules: ProductionRules) {
  const r = capacityRules(rules),
    issues: string[] = [],
    slots: { id: string; estimated: number; allocated: number }[] = [];
  let total = 0,
    reaction = 0,
    speech = 0;
  if (!ep.dramaticQuestion?.trim() || !ep.unitId || !ep.sourceStepIds?.length)
    issues.push(`${ep.id} 缺少单一戏剧目标和来源情节引用，需重新展开规划`);
  if (!ep.majorChanges || !ep.newCharacters || !ep.newRules)
    issues.push(`${ep.id} 缺少事件密度清单`);
  if ((ep.majorChanges?.length || 0) > r.maxMajorChanges)
    issues.push(
      `${ep.id} 重大变化超过 ${r.maxMajorChanges} 个，应拆为铺垫、选择、兑现及后果，不得只改标签`,
    );
  if ((ep.newCharacters?.length || 0) > r.maxNewCharacters)
    issues.push(`${ep.id} 新登场人物过多`);
  if ((ep.newRules?.length || 0) > r.maxNewRules)
    issues.push(`${ep.id} 新规则过多`);
  const scenes = new Set(ep.beats.map((b) => b.sceneId).filter(Boolean));
  if (scenes.size > r.maxScenes)
    issues.push(`${ep.id} 场景超过 ${r.maxScenes} 个`);
  for (const b of ep.beats) {
    if (!b.sceneId) issues.push(`${ep.id}/${b.id} 缺少场景 ID`);
    if (!b.performance) {
      issues.push(`${ep.id}/${b.id} 缺少实际试写对白、动作、反应的表演计时`);
      continue;
    }
    const p = performanceSeconds(b.performance, r),
      allocated = b.end - b.start;
    total += p.total;
    reaction += p.reaction;
    speech += p.speech;
    slots.push({ id: b.id, estimated: p.total, allocated });
    if (p.total > allocated + 0.05)
      issues.push(
        `${ep.id}/${b.id} 超载：表演估算 ${p.total.toFixed(1)} 秒 > 分配 ${allocated} 秒。拆分事件，不可只改 duration 或加速对白`,
      );
  }
  if (ep.beats.every((b) => b.performance)) {
    if (total > ep.duration * (1 - r.reserveRatio) + 0.05)
      issues.push(
        `${ep.id} 内容超载或缺少 ${(r.reserveRatio * 100).toFixed(0)}% 表演余量：估算 ${total.toFixed(1)} 秒 / ${ep.duration} 秒`,
      );
    if (total < ep.duration * (1 - r.maxSlackRatio) - 0.05)
      issues.push(
        `${ep.id} 无依据空余超过 ${(r.maxSlackRatio * 100).toFixed(0)}%，需补真实反应/行动或合并同一目标的片段，不能空镜凑时长`,
      );
    if (reaction < ep.duration * r.minReactionRatio - 0.05)
      issues.push(
        `${ep.id} 人物反应时间不足 ${(r.minReactionRatio * 100).toFixed(0)}%，保留看见、理解、犹豫、决定，不可全程赶事件`,
      );
  }
  return {
    issues,
    estimatedSeconds: total,
    speechSeconds: speech,
    reactionSeconds: reaction,
    reserveSeconds: ep.duration - total,
    slots,
  };
}
export function validateCoverage(
  episodes: EpisodeTiming[],
  inventory: StoryInventory,
) {
  const issues: string[] = [],
    steps = new Map(
      inventory.units.flatMap((u) =>
        u.steps.map((s) => [s.id, { unit: u.id, kind: s.kind }] as const),
      ),
    ),
    assigned = new Set<string>();
  let last = -1;
  const order = [...steps.keys()];
  for (const ep of episodes) {
    if (!inventory.units.some((u) => u.id === ep.unitId))
      issues.push(`${ep.id} 情节单元 ${ep.unitId} 不存在`);
    let milestones = 0;
    for (const id of ep.sourceStepIds || []) {
      const step = steps.get(id);
      if (!step) issues.push(`${ep.id} 情节 ${id} 不存在`);
      else if (step.unit !== ep.unitId)
        issues.push(`${ep.id} 跨单元打包多个戏剧目标：${id}`);
      if (assigned.has(id))
        issues.push(
          `${ep.id} 重复演出情节 ${id}；承接用简短回扣，不要重复分配`,
        );
      const index = order.indexOf(id);
      if (index >= 0 && index < last)
        issues.push(`${ep.id} 情节因果顺序倒退：${id}`);
      last = Math.max(last, index);
      assigned.add(id);
      if (step?.kind === "milestone") milestones++;
    }
    if (milestones > (ep.majorChanges?.length || 0))
      issues.push(`${ep.id} 重大变化清单漏报来源里程碑`);
  }
  for (const id of steps.keys())
    if (!assigned.has(id))
      issues.push(`来源情节 ${id} 未分配，不能靠删掉事件降低密度`);
  return issues;
}
export function capacityPrompt(rules: ProductionRules) {
  const r = capacityRules(rules);
  return `单集容量标准 v2（本平台可调制作默认值，不是行业统一定律）：一集只推进一个戏剧目标/情节单元，可把同一个冲突连续演多集，不要求每集完成一个大事件或完整成长循环。最多 ${r.maxScenes} 个实际场景、${r.maxMajorChanges} 个重大变化、${r.maxNewCharacters} 个新人物、${r.maxNewRules} 条新规则。破境、治愈关系、战胜对手、身份揭晓等不可在一集叠加兑现；重点场面按发生→感知→反应→选择→后果充分展开；六种模板是可选功能不是每集六步强制闭环。\n先展开全剧情节清单再按容量拆集，禁止先定集数再填内容。每集引用同一 unitId 的若干连续 sourceStepIds，完整覆盖来源，不漏项、不重复、不跨多个主事件打包。对简单行为不要机械拆成一集，短片段可合并到同一目标；反复羞辱/旁白总结/无意义空镜不是展开。\n每个节拍必须填 sceneId 和 performance：{dialogue:[{speaker:"人物",text:"试写实际说出的完整台词，不能写约100字"}],actions:[{description:"单个可表演动作，不可写大战后胜利一类结果摘要",seconds:8,overlapSpeech:false}],reaction:{description:"具体表情/停顿/视线/理解与决定",seconds:3},transitionSeconds:0}。分集阶段是计时用试写而非最终对白；剧本阶段这里必须列出全部实际对白/旁白。中文按 ${r.speechUnitsPerSecond} 个发音单元/秒估算，加标点停顿及说话人交接。算法为：非重叠动作之和 + max(对白时间,明确可与对白重叠的动作之和) + 独立反应 + 转场；动作彼此按顺序计时，不可虚标重叠。总内容估时最多占单集 ${(1 - r.reserveRatio) * 100}%，为表演保留 ${r.reserveRatio * 100}%；独立反应至少 ${r.minReactionRatio * 100}%；无依据空余不得超过 ${r.maxSlackRatio * 100}%。这是规划估算，不是实测保证，后续配音及动态分镜必须复核。\n超载时沿自然戏剧断点拆集、重新编号和衔接；不得仅把115改成120、提高语速、删除反应或把完整动作偷改成旁白来通过。第一集正式剧本超载则报告需要上游重新拆分，不擅自改已确认全剧边界。每集额外字段 dramaticQuestion:"本集唯一问题",unitId:"来源单元",sourceStepIds:["来源步骤"],majorChanges:["实际不可逆重大变化，无则空数组"],newCharacters:[],newRules:[]。正文每集使用 ### EP001 标题，方便单集独立审核。`;
}

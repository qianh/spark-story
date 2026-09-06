import { z } from "zod";
import {
  capacityRulesSchema,
  performanceSchema,
  inventorySchema,
  capacityAudit,
  validateCoverage,
  capacityPrompt,
} from "./capacity";

export const narrativeTemplates = [
  {
    id: "reward",
    name: "冲突与爽点",
    beats: "异常/危机开场→处境→冲突升级→小反转→兑现爽点→新悬念",
  },
  {
    id: "suspense",
    name: "悬疑解谜",
    beats: "异常问题→线索→误导→证据反转→局部解答→更深疑问",
  },
  {
    id: "relationship",
    name: "情感关系",
    beats: "关系失衡→诉求→误解/试探→情绪转折→关系变化→选择",
  },
  {
    id: "action",
    name: "动作闯关",
    beats: "目标/危机→空间与规则→阻碍→策略改变→行动结果→新代价",
  },
  {
    id: "comedy",
    name: "轻喜剧",
    beats: "反常设定→铺垫→递进误会→意外反转→笑点兑现→回扣",
  },
  {
    id: "growth",
    name: "世界观与成长",
    beats: "能力异常→必要规则→试炼→发现限制→付出代价并成长→新目标",
  },
] as const;
export const productionRulesSchema = z
  .object({
    minSeconds: z.number().int().min(1).max(600).default(90),
    maxSeconds: z.number().int().min(1).max(600).default(120),
    narrative: z
      .enum([
        "reward",
        "suspense",
        "relationship",
        "action",
        "comedy",
        "growth",
      ])
      .default("reward"),
    capacity: capacityRulesSchema.optional(),
  })
  .refine((v) => v.minSeconds <= v.maxSeconds, "最小时长不能超过最大时长");
export type ProductionRules = z.infer<typeof productionRulesSchema>;
const beatSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  purpose: z.enum([
    "hook",
    "setup",
    "conflict",
    "turn",
    "payoff",
    "cliffhanger",
    "closure",
  ]),
  information: z.string().min(1),
  change: z.string().min(1),
  exitState: z.string().min(1),
  sceneId: z.string().min(1).optional(),
  performance: performanceSchema.optional(),
});
export const episodeSchema = z.object({
  id: z.string().regex(/^EP\d{3,}$/),
  duration: z.number().positive(),
  beats: z.array(beatSchema).min(1),
  dramaticQuestion: z.string().min(1).optional(),
  unitId: z.string().min(1).optional(),
  sourceStepIds: z.array(z.string().min(1)).optional(),
  majorChanges: z.array(z.string().min(1)).optional(),
  newCharacters: z.array(z.string().min(1)).optional(),
  newRules: z.array(z.string().min(1)).optional(),
});
export type EpisodeTiming = z.infer<typeof episodeSchema>;
const manifestSchema = z.object({
  episodes: z.array(episodeSchema).min(1),
  inventory: inventorySchema.optional(),
});
export function timingManifest(content: string) {
  const match = content.match(/```production-json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return manifestSchema.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}
export function durationIssues(
  seconds: number,
  rules: ProductionRules,
  label: string,
) {
  return !Number.isFinite(seconds) ||
    seconds < rules.minSeconds - 0.05 ||
    seconds > rules.maxSeconds + 0.05
    ? [
        `${label} 时长 ${seconds.toFixed(2)} 秒，不在 ${rules.minSeconds}～${rules.maxSeconds} 秒内；调整内容或节奏，不要机械拉伸或截断。`,
      ]
    : [];
}
export function validateTextProduction(
  content: string,
  stage: number,
  rules: ProductionRules,
  episodeNumber?: number,
): string[] {
  if (stage !== 1 && stage !== 2) return [];
  const manifest = timingManifest(content);
  if (!manifest)
    return [
      "缺少有效 production-json 时间清单；旧版规划需按当前制作规则重新规划，正文和时间清单必须对应。",
    ];
  const issues: string[] = [];
  if (stage === 1) {
    if (!manifest.inventory)
      issues.push("缺少经过展开的全剧情节清单，先展开事件再拆集");
    else
      issues.push(...validateCoverage(manifest.episodes, manifest.inventory));
  }
  if (stage === 2 && manifest.episodes.length !== 1)
    issues.push("第一集剧本只能包含 EP001。");
  manifest.episodes.forEach((ep, index) => {
    const expected = `EP${String(stage === 2 ? episodeNumber || 1 : index + 1).padStart(3, "0")}`;
    if (ep.id !== expected)
      issues.push(`集编号应为 ${expected}，收到 ${ep.id}`);
    issues.push(...durationIssues(ep.duration, rules, ep.id));
    if (!episodeNumber) issues.push(...capacityAudit(ep, rules).issues);
    else
      for (const b of ep.beats) {
        if (!b.sceneId || !b.performance)
          issues.push(`${ep.id}/${b.id} 缺少场景与实际对白、动作`);
      }
    let cursor = 0;
    const ids = new Set<string>();
    for (const b of ep.beats) {
      if (ids.has(b.id)) issues.push(`${ep.id} 节拍 ID 重复：${b.id}`);
      ids.add(b.id);
      if (Math.abs(b.start - cursor) > 0.05 || b.end <= b.start)
        issues.push(
          `${ep.id}/${b.id} 节拍重叠、空档或倒序，应从 ${cursor} 秒开始`,
        );
      cursor = b.end;
    }
    if (Math.abs(cursor - ep.duration) > 0.05)
      issues.push(`${ep.id} 节拍未完整覆盖单集时长`);
    if (!episodeNumber && ep.beats[0].purpose !== "hook")
      issues.push(
        `${ep.id} 开场需要明确的 hook，可采用承接/危机/问题/反常，不必强行制造冲突`,
      );
    if (
      !episodeNumber &&
      !["cliffhanger", "closure"].includes(ep.beats.at(-1)!.purpose)
    )
      issues.push(`${ep.id} 结尾需要悬念或收束`);
  });
  return issues;
}
export function validateShotTiming(
  shots: {
    id: string;
    beatId?: string;
    duration: number;
    dialogue?: string;
    sceneId?: string;
  }[],
  rules: ProductionRules,
  episode?: EpisodeTiming,
): string[] {
  const issues = durationIssues(
    shots.reduce((sum, s) => sum + s.duration, 0),
    rules,
    "镜头总计",
  );
  const ids = new Set<string>();
  let previous = -1;
  for (const s of shots) {
    if (ids.has(s.id)) issues.push(`镜头 ID 重复：${s.id}`);
    ids.add(s.id);
    if (!Number.isFinite(s.duration) || s.duration <= 0)
      issues.push(`${s.id} 时长无效`);
    if (episode) {
      const index = episode.beats.findIndex((b) => b.id === s.beatId);
      if (index < 0)
        issues.push(`${s.id} 引用了不存在的节拍 ${s.beatId || "未填写"}`);
      else {
        if (index < previous) issues.push(`${s.id} 节拍顺序倒退`);
        previous = index;
      }
    }
  }
  if (episode)
    for (const b of episode.beats) {
      if (b.performance) {
        const normalize = (v: string) => v.replace(/[\s\p{P}]/gu, "");
        const planned = b.performance.dialogue.map((d) => d.text).join("");
        const actual = shots
          .filter((s) => s.beatId === b.id)
          .map((s) => s.dialogue || "")
          .join("");
        if (normalize(planned) !== normalize(actual))
          issues.push(
            `节拍 ${b.id} 分镜台词与已计时剧本不一致，不可省略、添加或重复对白来凑时间`,
          );
        if (shots.some((s) => s.beatId === b.id && s.sceneId !== b.sceneId))
          issues.push(`节拍 ${b.id} 分镜场景与剧本不一致`);
      }
      const duration = shots
        .filter((s) => s.beatId === b.id)
        .reduce((sum, s) => sum + s.duration, 0);
      if (Math.abs(duration - (b.end - b.start)) > 0.05)
        issues.push(
          `节拍 ${b.id} 分镜时长 ${duration} 秒，应为 ${b.end - b.start} 秒`,
        );
    }
  return issues;
}
export function validateScriptBoundary(content: string, plan: string) {
  const script = timingManifest(content)?.episodes[0],
    first = timingManifest(plan)?.episodes[0];
  if (!script || !first) return ["缺少可比较的第一集边界"];
  return script.unitId !== first.unitId ||
    JSON.stringify(script.sourceStepIds) !== JSON.stringify(first.sourceStepIds)
    ? [
        "第一集剧本越过已确认的情节边界；应回上游重新拆集，不得偷加或删掉来源步骤",
      ]
    : [];
}
export function productionPrompt(rules: ProductionRules, stage: number) {
  return (
    baseProductionPrompt(rules, stage) +
    (stage > 0 ? "\n" + capacityPrompt(rules) : "")
  );
}
function baseProductionPrompt(rules: ProductionRules, stage: number) {
  const template = narrativeTemplates.find((t) => t.id === rules.narrative)!;
  return `制作硬约束：每集最终时长 ${rules.minSeconds}～${rules.maxSeconds} 秒，包含停顿、动作、片头片尾；按此容量自然确定集数，不沿用旧集数。叙事模板：${template.name}（${template.beats}）。模板是可调整的创作框架，不是所有题材的固定秒数公式。先分配剧情节拍，再拆分场景和镜头；剧情节拍、剪辑镜头、模型生成片段不是同一层。对白估算需结合语速、停顿和动作重叠；配音实测超长时精简对白或重规划，不能无限加长镜头。主控逐集检查开场吸引力、信息增量、人物变化、兑现与结尾，然后全剧检查因果、伏笔回收及重复情节。返工定位 EP/节拍/镜头 ID，保留未受影响内容。${stage === 1 || stage === 2 ? '\n正文仍为中文 Markdown，末尾必须附唯一的 ```production-json 代码块（合法 JSON，无注释）：{"episodes":[{"id":"EP001","duration":90,"beats":[{"id":"EP001-B01","start":0,"end":4,"purpose":"hook","information":"新增信息","change":"人物变化","exitState":"离开本节拍时的状态"}]}]}。示例只展示字段，不是完整交付。purpose 仅可为 hook/setup/conflict/turn/payoff/cliffhanger/closure。节拍从 0 连续覆盖到 duration，编号稳定唯一。开场 hook、结尾 cliffhanger 或 closure，中间按题材取舍。分集阶段列出全部集；第一集剧本只列 EP001，正文逐节拍落实分场、动作、完整对白并对应时间清单。' : ""}`;
}

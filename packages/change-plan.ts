import { z } from "zod";
import { rank } from "./series";

export const changeActionSchema = z.enum([
  "revise_story",
  "revise_look_registry",
  "revise_series_plan",
  "revise_episode_script",
  "revise_shot_list",
  "revise_asset_prompt",
  "regenerate_asset",
  "revise_voice",
]);

export const changeItemSchema = z.object({
  action: changeActionSchema,
  targetId: z.string().default(""),
  title: z.string().min(1),
});

export const changeNoteSchema = z.object({
  title: z.string().min(1),
  reason: z.string().min(1),
});

export const changeOriginSchema = z.enum([
  "none",
  "outline",
  "story",
  "plan",
  "script",
  "shots",
]);

export const changePlanSchema = z.object({
  clear: z.boolean(),
  instruction: z.string().min(1),
  explanation: z.string().min(1),
  origin: changeOriginSchema.default("none"),
  change: z.array(changeItemSchema).default([]),
  invalidate: z.array(changeNoteSchema).default([]),
  keep: z.array(changeNoteSchema).default([]),
});

export type ChangePlan = z.infer<typeof changePlanSchema>;
export type ChangeItem = z.infer<typeof changeItemSchema>;

const lookActions = new Set([
  "revise_asset_prompt",
  "regenerate_asset",
  "revise_voice",
]);

const upstreamActions = new Set([
  "revise_story",
  "revise_look_registry",
  "revise_series_plan",
  "revise_episode_script",
]);

const actionStage: Record<z.infer<typeof changeActionSchema>, number> = {
  revise_story: 7,
  revise_look_registry: 7,
  revise_series_plan: 1,
  revise_episode_script: 2,
  revise_shot_list: 8,
  revise_asset_prompt: 3,
  regenerate_asset: 3,
  revise_voice: 3,
};

const originStage: Record<z.infer<typeof changeOriginSchema>, number> = {
  none: 99,
  outline: 0,
  story: 7,
  plan: 1,
  script: 2,
  shots: 8,
};

export function looksWithoutUpstream(plan: ChangePlan) {
  return (
    plan.change.some((item) => lookActions.has(item.action)) &&
    !plan.change.some((item) => upstreamActions.has(item.action))
  );
}

export function assertChangePlan(plan: ChangePlan) {
  if (looksWithoutUpstream(plan))
    throw Error("不允许只改提示词或只重出图；须先改剧情、剧本或人物设定");
  if (plan.origin === "none" || !plan.change.length) return;
  const origin = originStage[plan.origin];
  for (const item of plan.change) {
    if (rank(actionStage[item.action]) < rank(origin))
      throw Error("不影响该流程前置的步骤");
  }
}

export function sortChangeItems(items: ChangeItem[]) {
  return [...items].sort(
    (a, b) => rank(actionStage[a.action]) - rank(actionStage[b.action]),
  );
}

export function parseChangePlan(value: unknown) {
  const plan = changePlanSchema.parse(value);
  assertChangePlan(plan);
  return plan;
}

export function readStoredPlan(proposal: string): ChangePlan | null {
  try {
    return changePlanSchema.parse(JSON.parse(proposal));
  } catch {
    return null;
  }
}

export function formatChangePlan(plan: ChangePlan) {
  const lines = [plan.explanation, "", "将改："];
  for (const item of plan.change) lines.push(`- ${item.title}`);
  if (plan.invalidate.length) {
    lines.push("", "将作废：");
    for (const item of plan.invalidate)
      lines.push(`- ${item.title}（${item.reason}）`);
  }
  if (plan.keep.length) {
    lines.push("", "将保留：");
    for (const item of plan.keep) lines.push(`- ${item.title}（${item.reason}）`);
  }
  return lines.join("\n");
}

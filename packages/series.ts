import { z } from "zod";

// Existing stage IDs are stable on disk; display/dependency order is explicit.
export const stageOrder = [0, 7, 1, 2, 8, 3, 4, 5, 6];
export const globalStages = [0, 7, 1];
export const episodeStages = [2, 8, 3, 4, 5, 6];
export const isMediaStage = (stage: number) => [3, 4, 5, 6].includes(stage);
export const rank = (stage: number) => stageOrder.indexOf(stage);
export const episodeLabel = (n: number) => `EP${String(n).padStart(3, "0")}`;
const nonempty = z.string().trim().min(1);
export const storyOutlineSchema = z.object({
  bible: nonempty.max(16000),
  chapters: z
    .array(
      z.object({ id: nonempty, title: nonempty, synopsis: nonempty.max(4000) }),
    )
    .min(1)
    .max(120),
});
export const chapterSchema = z.object({
  id: nonempty,
  title: nonempty,
  content: nonempty.min(100).max(24000),
  continuity: nonempty.max(4000),
  beats: z
    .array(
      z.object({
        id: nonempty,
        eventId: nonempty,
        description: nonempty.max(1200),
      }),
    )
    .min(1)
    .max(60),
});
export const storySchema = z.object({
  type: z.literal("story"),
  bible: nonempty,
  chapters: z.array(chapterSchema).min(1),
});
export const planEpisodeSchema = z.object({
  id: z.string().regex(/^EP\d{3,}$/),
  title: nonempty,
  sourceBeatIds: z.array(nonempty).min(1),
  summary: nonempty.max(4000),
  opening: nonempty.max(1200),
  ending: nonempty.max(1200),
  change: nonempty.max(1200),
  timingReason: nonempty.max(2000),
  estimatedSeconds: z.number().positive(),
});
export const seriesPlanSchema = z.object({
  type: z.literal("series-plan"),
  rationale: nonempty.max(6000),
  episodes: z.array(planEpisodeSchema).min(1).max(500),
});
export type Story = z.infer<typeof storySchema>;
export type SeriesPlan = z.infer<typeof seriesPlanSchema>;
export function structured<T>(content: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}
export function storyIssues(story: Story) {
  const ids = [
    ...story.chapters.map((c) => c.id),
    ...story.chapters.flatMap((c) => c.beats.map((b) => b.id)),
  ];
  return new Set(ids).size === ids.length ? [] : ["章节或故事段落 ID 重复"];
}
export function planIssues(plan: SeriesPlan, story: Story) {
  const expected = story.chapters.flatMap((c) => c.beats.map((b) => b.id));
  const actual = plan.episodes.flatMap((ep) => ep.sourceBeatIds);
  const issues: string[] = [];
  if (new Set(actual).size !== actual.length)
    issues.push("分集重复分配故事段落；承接回扣不要重复分配来源");
  const missing = expected.filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !expected.includes(id));
  if (missing.length) issues.push(`遗漏故事段落：${missing.join("、")}`);
  if (unknown.length) issues.push(`未知故事段落：${unknown.join("、")}`);
  if (
    !missing.length &&
    !unknown.length &&
    actual.some((id, i) => id !== expected[i])
  )
    issues.push("分集改变了已确认故事的呈现顺序；调整叙事顺序应先修订故事稿");
  plan.episodes.forEach((ep, i) => {
    if (ep.id !== episodeLabel(i + 1))
      issues.push(`集编号应为 ${episodeLabel(i + 1)}`);
  });
  return issues;
}

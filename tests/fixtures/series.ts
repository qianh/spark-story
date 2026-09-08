import { timingManifest } from "../../packages/production";
import { timingFixture } from "./timing";
import type { Store } from "../../apps/server/store";
export const storyFixture = {
  type: "story" as const,
  bible: "女孩收到来信，在第二章决定回应；事件 E001 跨章延续。",
  chapters: [1, 2].map((n) => ({
    id: `CH00${n}`,
    title: n === 1 ? "雨中相遇" : "真相揭晓",
    content: (n === 1
      ? "女孩走到山门前，停下脚步。她拿出那封来信，发现字迹已经被雨水浸湿。信使站在檐下，问她要不要进来。她没有立刻回答，而是抬头看着门后的灯火。"
      : "女孩终于读懂了来信。她转身回到山门，把信交给信使，说她愿意留下来。信使侧身让开，她擦掉脸上的雨水，第一次主动走进了那道门。"
    ).repeat(3),
    continuity:
      n === 1
        ? "女孩尚未决定是否留下，信还在手中。"
        : "女孩留下并交出信件，悬念回收。",
    beats: [
      {
        id: `CH00${n}-B001`,
        eventId: "E001",
        description:
          n === 1 ? "雨中收到来信，犹豫是否留下" : "读懂信件，决定留下",
      },
    ],
  })),
};
export const outlineFixture = {
  bible: storyFixture.bible,
  chapters: storyFixture.chapters.map((c) => ({
    id: c.id,
    title: c.title,
    synopsis: c.continuity,
  })),
};
export const planFixture = {
  type: "series-plan" as const,
  rationale: "按相遇与决定两个自然段落拆集，同一事件跨集。",
  episodes: storyFixture.chapters.map((c, i) => ({
    id: `EP00${i + 1}`,
    title: c.title,
    sourceBeatIds: c.beats.map((b) => b.id),
    summary: c.continuity,
    opening: "上一阶段后的状态",
    ending: c.continuity,
    change: "从犹豫到选择",
    estimatedSeconds: 90,
    timingReason: "对白、观察与拆信动作粗估",
  })),
};
export function scriptFixture(n = 1, seconds = 90) {
  const m = timingManifest(timingFixture(seconds))!;
  m.episodes[0].id = `EP00${n}`;
  m.episodes[0].sourceStepIds = [`CH00${n}-B001`];
  return `# 第 ${n} 集剧本\n雨中相遇\n\n\`\`\`production-json\n${JSON.stringify(m)}\n\`\`\``;
}
export function approveFixture(
  s: Store,
  projectId: string,
  stage: number,
  content: string,
  episode = 0,
) {
  const t = s
    .tasks(projectId)
    .find((t) => t.stage === stage && (t.episode || 0) === episode)!;
  const a = s.publish(t.id, t.revision, content);
  s.db.run("UPDATE artifacts SET status='reviewed' WHERE id=?", [a.id]);
  s.updateTask(t.id, t.revision, "awaiting_user");
  s.approve(t.id, t.revision, a.id);
  return s.task(t.id);
}
export function seedSeries(s: Store, projectId: string) {
  approveFixture(s, projectId, 0, "故事概要");
  approveFixture(s, projectId, 7, JSON.stringify(storyFixture));
  approveFixture(s, projectId, 1, JSON.stringify(planFixture));
}
export function seriesResponse(prompt: string) {
  if (prompt.startsWith("你是主控"))
    return JSON.stringify({ pass: true, feedback: "事实和衔接通过" });
  if (prompt.startsWith("你是外观登记 Agent"))
    return JSON.stringify({
      type: "look-registry",
      entities: [
        {
          id: "girl",
          name: "女孩",
          kind: "character",
          variants: [
            {
              id: "youth",
              name: "青年",
              kind: "growth",
              identity: "年轻女孩",
              form: "日常衣装",
              source: "女孩收到来信",
              ageBand: "youth",
            },
          ],
        },
      ],
    });
  if (prompt.startsWith("你是故事 Agent") && prompt.includes("规划覆盖"))
    return JSON.stringify(outlineFixture);
  if (prompt.startsWith("你是故事 Agent"))
    return JSON.stringify(
      storyFixture.chapters[prompt.includes('当前章：{"id":"CH002"') ? 1 : 0],
    );
  if (prompt.startsWith("你是分集规划 Agent"))
    return JSON.stringify(planFixture);
  if (prompt.startsWith("你是单集剧情 Agent"))
    return JSON.stringify({
      content: scriptFixture(prompt.includes("细化 EP002") ? 2 : 1),
    });
  return "# 故事概要\n女孩收到来信，决定留下。";
}

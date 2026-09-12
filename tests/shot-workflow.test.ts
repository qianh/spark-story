import { test, expect } from "bun:test";
import { Store } from "../apps/server/store";
import type { Runtime } from "../apps/server/runtime";
import type { Connection } from "../packages/domain";
import { storyboardSchema } from "../packages/media";
import {
  produceShotPlan,
  mergeShotPatch,
  reviewWindow,
} from "../apps/server/shot-workflow";
import { scriptFixture } from "./fixtures/series";
const board = storyboardSchema.parse({
  summary: "分镜",
  shots: [1, 2, 3].map((n) => ({
    id: `SH00${n}`,
    title: "镜头",
    prompt: "女孩",
    imagePrompt: "女孩站立",
    motionPrompt: "转身",
    camera: "中景",
    startState: "站立",
    endState: "转身",
    duration: n === 1 ? 45 : 22.5,
    beatId: n === 1 ? "B1" : "B2",
    sceneId: "scene1",
    assetIds: ["girl"],
    dialogue: n === 1 ? "你好" : "",
  })),
});
test("镜头补丁仅替换授权镜头，保留顺序及未涉及内容", () => {
  const changed = { ...board.shots[0], startState: "已经站立" };
  const result = mergeShotPatch(board, { shots: [changed] }, ["SH001"]);
  expect(result.shots[0]).toEqual(changed);
  expect(result.shots.slice(1)).toEqual(board.shots.slice(1));
  expect(board.shots[0].startState).toBe("站立");
  for (const shots of [
    [board.shots[1]],
    [changed, changed],
    [{ ...changed, id: "unknown" }],
    [],
  ])
    expect(() => mergeShotPatch(board, { shots }, ["SH001"])).toThrow();
  expect(reviewWindow(board, ["SH001"]).map((s) => s.id)).toEqual([
    "SH001",
    "SH002",
  ]);
});

test("一次列全问题、局部返工；断线恢复保留约束与问题，建议不阻断", async () => {
  const store = new Store(":memory:");
  const p = store.createProject({
    name: "分镜",
    source: "女孩",
    inputType: "idea",
    aspect: "9:16",
    template: "cel",
    budget: 0,
  });
  store.patchSettings(p.id, { modelReviewEnabled: true });
  const task = store.tasks(p.id).find((t) => t.stage === 8)!;
  const prompts: string[] = [];
  let reviews = 0,
    disconnected = true;
  const issue = {
    shotId: "SH001",
    field: "startState",
    severity: "blocking",
    evidence: "雨中相遇",
    reason: "状态不明确",
    fix: "写清站立",
  };
  const runtime = {
    store,
    call: async (_t: unknown, _a: unknown, _c: unknown, prompt: string) => {
      prompts.push(prompt);
      if (prompt.startsWith("你是分镜约束"))
        return JSON.stringify({
          facts: [{ evidence: "雨中相遇", rule: "保持雨中" }],
        });
      if (prompt.startsWith("你是分镜 Agent")) return JSON.stringify(board);
      if (prompt.startsWith("你是分镜修复")) {
        if (disconnected) {
          disconnected = false;
          throw Error("连接中断");
        }
        return JSON.stringify({
          shots: [{ ...board.shots[0], startState: "已经站立" }],
        });
      }
      if (++reviews === 1) return JSON.stringify({ issues: [issue] });
      return JSON.stringify({
        issues: [
          {
            ...issue,
            severity: "suggestion",
            evidence: "",
            reason: "可考虑近景",
          },
        ],
      });
    },
  } as unknown as Runtime;
  const run = () =>
    produceShotPlan(
      runtime,
      task,
      "attempt",
      {} as Connection,
      {} as Connection,
      scriptFixture(),
      new AbortController().signal,
    );
  try {
    await expect(run()).rejects.toThrow("连接中断");
    const result = await run();
    expect(result.shots[0].startState).toBe("已经站立");
    expect(result.shots.slice(1)).toEqual(board.shots.slice(1));
    expect(prompts.filter((p) => p.startsWith("你是分镜约束"))).toHaveLength(1);
    expect(prompts.filter((p) => p.startsWith("你是分镜 Agent"))).toHaveLength(
      1,
    );
    const finalReview = prompts.filter((p) => p.startsWith("你是主控")).at(-1)!;
    expect(finalReview).not.toContain('"id":"SH003"');
    expect(finalReview).toContain("一次列全");
    expect(
      store.list(
        "SELECT * FROM planning_checkpoints WHERE kind='文字分镜 EP001' AND status='rejected'",
      ),
    ).toHaveLength(1);
    expect(
      store.list(
        "SELECT * FROM planning_checkpoints WHERE kind='文字分镜 EP001' AND status='reviewed'",
      ),
    ).toHaveLength(1);
  } finally {
    store.db.close();
  }
});

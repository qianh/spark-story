import { test, expect } from "bun:test";
import {
  capacityAudit,
  performanceSeconds,
  capacityRulesSchema,
  inventorySchema,
  validateCoverage,
} from "../packages/capacity";
import {
  productionRulesSchema,
  timingManifest,
  validateTextProduction,
} from "../packages/production";
import { timingFixture } from "./fixtures/timing";

const rules = productionRulesSchema.parse({});
test("时长来自实际试写对白、串行动作、反应；重叠必须明确", () => {
  const p = {
    dialogue: [{ speaker: "晚晴", text: "我想自己决定。" }],
    actions: [{ description: "走到门边", seconds: 8, overlapSpeech: false }],
    reaction: { description: "看向师兄，犹豫后点头", seconds: 3 },
    transitionSeconds: 1,
  };
  const serial = performanceSeconds(p, capacityRulesSchema.parse({}));
  expect(serial.total).toBeGreaterThan(12);
  expect(
    performanceSeconds(
      { ...p, actions: [{ ...p.actions[0], overlapSpeech: true }] },
      capacityRulesSchema.parse({}),
    ).total,
  ).toBe(12);
});
test("旧版只填100秒的时间表不再通过", () => {
  const m = timingManifest(timingFixture())!;
  for (const b of m.episodes[0].beats) delete b.performance;
  expect(
    validateTextProduction(
      "```production-json\n" + JSON.stringify(m) + "\n```",
      1,
      rules,
    ).join(),
  ).toContain("表演计时");
});
test("超长对白、多个重大事件、缺少反应余量会被拦截", () => {
  const ep = timingManifest(timingFixture())!.episodes[0];
  expect(capacityAudit(ep, rules).issues).toEqual([]);
  ep.beats[0].performance!.dialogue[0].text = "重要的事情必须慢慢说".repeat(
    100,
  );
  ep.majorChanges = ["突破境界", "治愈师兄"];
  for (const b of ep.beats) b.performance!.reaction.seconds = 0;
  const issues = capacityAudit(ep, rules).issues.join();
  expect(issues).toContain("超载");
  expect(issues).toContain("重大变化");
  expect(issues).toContain("反应");
});
test("多个场景、重复节拍或无依据留白不能伪装自然节奏", () => {
  const ep = timingManifest(timingFixture())!.episodes[0];
  for (const b of ep.beats) b.performance!.actions = [];
  expect(capacityAudit(ep, rules).issues.join()).toContain("空余");
  expect(
    inventorySchema.safeParse({
      units: [
        {
          id: "u",
          arc: "起",
          sourceAnchor: "来源",
          description: "展开",
          dramaticQuestion: "是否相信",
          steps: [
            { id: "s", description: "动作", kind: "choice" },
            { id: "s", description: "另一个动作", kind: "reaction" },
          ],
        },
      ],
    }).success,
  ).toBe(false);
});
test("情节清单必须完整分配，不得漏项、重复或跨单元打包", () => {
  const m = timingManifest(timingFixture())!;
  expect(validateCoverage(m.episodes, m.inventory!)).toEqual([]);
  m.episodes[0].sourceStepIds = ["不存在"];
  expect(validateCoverage(m.episodes, m.inventory!).join()).toContain("未分配");
  expect(validateCoverage(m.episodes, m.inventory!).join()).toContain("不存在");
});

import { test, expect } from "bun:test";
import {
  productionRulesSchema,
  validateTextProduction,
  validateShotTiming,
  productionPrompt,
  type EpisodeTiming,
} from "../packages/production";
import { Store } from "../apps/server/store";
import { timingFixture } from "./fixtures/timing";
import { timingManifest } from "../packages/production";

const rules = productionRulesSchema.parse({});
const episode: EpisodeTiming = {
  id: "EP001",
  duration: 90,
  beats: [
    {
      id: "B1",
      start: 0,
      end: 4,
      purpose: "hook",
      information: "异象",
      change: "警觉",
      exitState: "追踪",
    },
    {
      id: "B2",
      start: 4,
      end: 80,
      purpose: "conflict",
      information: "代价",
      change: "选择",
      exitState: "受伤",
    },
    {
      id: "B3",
      start: 80,
      end: 90,
      purpose: "closure",
      information: "结果",
      change: "成长",
      exitState: "归来",
    },
  ],
};
const content = (episodes: any[]) =>
  "# 正文\n```production-json\n" + JSON.stringify({ episodes }) + "\n```";
test("默认时长和六种叙事模板；无效配置不能保存", () => {
  expect(rules.minSeconds).toBe(90);
  expect(rules.maxSeconds).toBe(120);
  expect(
    productionRulesSchema.safeParse({ minSeconds: 121, maxSeconds: 90 })
      .success,
  ).toBe(false);
  expect(productionPrompt(rules, 1)).toContain("production-json");
});
test("逐集校验时长、连续编号和节拍覆盖，不锁定集数", () => {
  expect(validateTextProduction(timingFixture(), 1, rules)).toEqual([]);
  expect(
    validateTextProduction(
      content([{ ...episode, duration: 180 }]),
      1,
      rules,
    ).join(),
  ).toContain("90～120");
  expect(
    validateTextProduction(
      content([{ ...episode, id: "EP002" }]),
      1,
      rules,
    ).join(),
  ).toContain("EP001");
  expect(
    validateTextProduction(
      content([{ ...episode, beats: [{ ...episode.beats[0], start: 1 }] }]),
      1,
      rules,
    ).join(),
  ).toContain("节拍");
  expect(validateTextProduction("旧规划", 1, rules).join()).toContain(
    "production-json",
  );
  expect(
    validateTextProduction("```production-json\n{}\n```", 1, rules).length,
  ).toBeGreaterThan(0);
  expect(validateTextProduction("故事概要", 0, rules)).toEqual([]);
});
test("第一集不能混入其他集；镜头时长按节拍验收", () => {
  expect(
    validateTextProduction(
      content([episode, { ...episode, id: "EP002" }]),
      2,
      rules,
    ).length,
  ).toBeGreaterThan(0);
  const shots = episode.beats.map((b) => ({
    id: b.id,
    beatId: b.id,
    duration: b.end - b.start,
  }));
  expect(validateShotTiming(shots, rules, episode)).toEqual([]);
  expect(
    validateShotTiming([{ ...shots[0], duration: 130 }], rules, episode).join(),
  ).toContain("90～120");
  expect(
    validateShotTiming(
      [{ ...shots[0], beatId: "missing" }, ...shots.slice(1)],
      rules,
      episode,
    ).join(),
  ).toContain("missing");
});
test("制作规则保存保留概要和历史产物、重置分集及下游；执行中拒绝修改", () => {
  const s = new Store(":memory:");
  try {
    const p = s.createProject({
      name: "测试",
      source: "创意",
      inputType: "idea",
      aspect: "9:16",
      template: "cel",
      budget: 0,
    });
    expect(s.productionRules(p.id)).toEqual(rules);
    const tasks = s.board(p.id).tasks;
    const a = s.publish(tasks[0].id, 1, "已确认概要");
    s.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [a.id]);
    s.updateTask(tasks[0].id, 1, "approved");
    s.saveProductionRules(p.id, { ...rules, narrative: "suspense" });
    expect(s.task(tasks[0].id).revision).toBe(1);
    expect(s.task(tasks[1].id).status).toBe("ready");
    expect(s.productionRules(p.id).narrative).toBe("suspense");
    s.updateTask(tasks[1].id, 2, "running");
    expect(() => s.saveProductionRules(p.id, rules)).toThrow("执行");
  } finally {
    s.db.close();
  }
});

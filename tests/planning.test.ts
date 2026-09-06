import { test, expect } from "bun:test";
import { Store } from "../apps/server/store";
import {
  prepareInventory,
  attachInventory,
  episodeExcerpt,
} from "../apps/server/story-planner";
import { inventoryFixture, timingFixture } from "./fixtures/timing";
import { inventorySchema } from "../packages/capacity";
import {
  validateTextProduction,
  productionRulesSchema,
  validateScriptBoundary,
  timingManifest,
  validateShotTiming,
} from "../packages/production";
import type { Runtime } from "../apps/server/runtime";
import type { Task, Connection } from "../packages/domain";
test("恢复失败流中的完整清单，主控断线后候选持久化且不重复生成", async () => {
  const store = new Store(":memory:");
  try {
    store.createProject({
      name: "恢复",
      source: "来信",
      inputType: "idea",
      template: "cel",
      aspect: "9:16",
      budget: 0,
    });
    const task = store.one<Task>("SELECT * FROM tasks WHERE stage=1")!;
    store.db.run("INSERT INTO task_progress VALUES(?,?,?,?,?,?,?,?,?,?,?)", [
      task.id,
      task.revision,
      "old",
      "generate",
      "剧情",
      "test",
      "```json\n" +
        JSON.stringify(inventoryFixture()) +
        "\n```\n未完成的附加内容",
      "now",
      "now",
      "now",
      "failed",
    ]);
    let calls = 0;
    const runtime = {
      store,
      call: async (...args: any[]) => {
        expect(args[3]).toStartWith("你是主控");
        if (++calls === 1) throw Error("连接中断");
        return '{"pass":true,"feedback":"通过"}';
      },
    } as unknown as Runtime;
    const run = () =>
      prepareInventory(
        runtime,
        task,
        "a",
        {} as Connection,
        {} as Connection,
        "来源",
        new AbortController().signal,
      );
    await expect(run()).rejects.toThrow("连接中断");
    expect(
      store.one<any>("SELECT status FROM planning_checkpoints")!.status,
    ).toBe("candidate");
    expect(await run()).toEqual(inventorySchema.parse(inventoryFixture()));
    expect(calls).toBe(2);
  } finally {
    store.db.close();
  }
});
test("先展开再分集，清单审核通过持久化，同修订恢复不重复生成", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  try {
    store.createProject({
      name: "测试",
      source: "来信",
      inputType: "idea",
      template: "cel",
      aspect: "9:16",
      budget: 0,
    });
    const task = store.one<Task>("SELECT * FROM tasks WHERE stage=1")!;
    const runtime = {
      store,
      call: async (...args: any[]) => {
        calls++;
        if (args[3].startsWith("你是剧情展开")) {
          expect(args[3]).not.toContain("speechUnitsPerSecond");
          expect(args[3]).toContain("完成后立即结束");
        }
        return args[3].startsWith("你是剧情展开")
          ? JSON.stringify(inventoryFixture())
          : '{"pass":true,"feedback":"展开完整"}';
      },
    } as unknown as Runtime;
    const inventory = await prepareInventory(
      runtime,
      task,
      "attempt",
      {} as Connection,
      {} as Connection,
      "来源",
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    await prepareInventory(
      runtime,
      task,
      "attempt",
      {} as Connection,
      {} as Connection,
      "来源",
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    expect(
      validateTextProduction(
        attachInventory(timingFixture(), inventory),
        1,
        productionRulesSchema.parse({}),
      ),
    ).toEqual([]);
    expect(
      store.one<any>("SELECT status FROM planning_checkpoints")!.status,
    ).toBe("reviewed");
  } finally {
    store.db.close();
  }
});
test("清单连续不通过只返工三次，不产生可用分集依据", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  try {
    store.createProject({
      name: "测试",
      source: "来信",
      inputType: "idea",
      template: "cel",
      aspect: "9:16",
      budget: 0,
    });
    const task = store.one<Task>("SELECT * FROM tasks WHERE stage=1")!;
    const runtime = {
      store,
      call: async () => {
        calls++;
        return "{}";
      },
    } as unknown as Runtime;
    await expect(
      prepareInventory(
        runtime,
        task,
        "a",
        {} as Connection,
        {} as Connection,
        "",
        new AbortController().signal,
      ),
    ).rejects.toThrow("返工 3 次");
    expect(calls).toBe(4);
    expect(
      store.list("SELECT * FROM planning_checkpoints WHERE status='reviewed'"),
    ).toHaveLength(0);
  } finally {
    store.db.close();
  }
});
test("审核上下文只摘当前集；剧本边界及分镜对白不可偷偷改变", () => {
  expect(
    episodeExcerpt("### EP001 开始\n第一集\n### EP002 结束\n第二集", "EP001"),
  ).toContain("第一集");
  expect(
    episodeExcerpt("### EP001 开始\n第一集\n### EP002 结束\n第二集", "EP001"),
  ).not.toContain("第二集");
  expect(episodeExcerpt("### EP001 开始", "EP002")).toBe("");
  expect(
    attachInventory("旧文档", inventorySchema.parse(inventoryFixture())),
  ).toBe("旧文档");
  const m = timingManifest(timingFixture())!;
  m.episodes[0].sourceStepIds = ["另一事件"];
  expect(
    validateScriptBoundary(
      "```production-json\n" + JSON.stringify(m) + "\n```",
      timingFixture(),
    ).join(),
  ).toContain("边界");
  const ep = timingManifest(timingFixture())!.episodes[0];
  expect(
    validateShotTiming(
      ep.beats.map((b) => ({
        id: b.id,
        beatId: b.id,
        duration: b.end - b.start,
        sceneId: b.sceneId,
        dialogue: "删改台词",
      })),
      productionRulesSchema.parse({}),
      ep,
    ).join(),
  ).toContain("台词");
});

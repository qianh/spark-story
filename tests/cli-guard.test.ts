import { test, expect } from "bun:test";
import { CliActivityGuard } from "../apps/server/cli-guard";
import { recoverInventory } from "../apps/server/story-planner";
import { inventoryFixture } from "./fixtures/timing";
import { inventorySchema } from "../packages/capacity";

test("CLI 持续输出超过十五分钟不停止，闲置与总时限分别生效", () => {
  let now = 0;
  const guard = new CliActivityGuard({}, () => now);
  for (now = 60000; now < 3600000; now += 60000) {
    guard.activity();
    expect(guard.reason()).toBeUndefined();
  }
  now += 600000;
  expect(guard.reason()).toContain("无有效输出");
  now = 7200000;
  guard.activity();
  expect(guard.reason()).toContain("总时长");
});

test("完整清单后夹杂未完成对白可恢复，截断或多份不同清单不能恢复", () => {
  const raw = JSON.stringify(inventoryFixture());
  expect(
    recoverInventory("说明\n```json\n" + raw + "\n```\n未完成对白{"),
  ).toEqual(inventorySchema.parse(inventoryFixture()));
  expect(recoverInventory(raw.slice(0, -3))).toBeUndefined();
  expect(
    recoverInventory(
      "```json\n" +
        raw +
        "\n```\n```json\n" +
        JSON.stringify(inventoryFixture(2)) +
        "\n```",
    ),
  ).toBeUndefined();
});

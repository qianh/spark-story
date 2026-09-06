import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../apps/server/store";
import { timingFixture } from "./fixtures/timing";
import type { Connection } from "../packages/domain";
const stores: Store[] = [];
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  const p = s.createProject({
    name: "雨天来信",
    source: "少女在雨天看见未来",
    inputType: "idea",
    aspect: "9:16",
    template: "cel",
    budget: 100,
  });
  return {
    s,
    p,
    t: s.list<any>(
      "SELECT * FROM tasks WHERE projectId=? ORDER BY stage",
      p.id,
    )[0],
  };
}
afterEach(() => stores.splice(0).forEach((s) => s.db.close()));
const connection: Connection = {
  id: "api",
  name: "test",
  transport: "api",
  provider: "compatible",
  model: "test",
  baseUrl: "https://example.com/v1",
  keyEnv: "TEST_KEY",
  executable: "",
  reserveCents: 70,
  health: "unverified",
  version: "",
};
describe("持久任务规则", () => {
  test("项目不限制集数；下一阶段须待人工通过", () => {
    const { s, p, t } = setup();
    expect(s.list("SELECT * FROM tasks WHERE projectId=?", p.id)).toHaveLength(
      7,
    );
    const next = s.list<any>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=1",
      p.id,
    )[0];
    expect(s.canRun(next)).toBe(false);
    const a = s.publish(t.id, 1, "概要");
    s.updateTask(t.id, 1, "awaiting_user");
    expect(() => s.approve(t.id, 1, a.id)).toThrow();
    s.db.run("UPDATE artifacts SET status='reviewed' WHERE id=?", [a.id]);
    s.approve(t.id, 1, a.id);
    expect(s.canRun(s.task(next.id))).toBe(true);
    expect(s.task(next.id).status).toBe("ready");
    expect(s.task(next.id).title).toBe("全剧分集规划");
    const script = s.one<any>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=2",
      p.id,
    )!;
    expect(script.title).toBe("第一集剧本");
    expect(s.canRun(script)).toBe(false);
    const plan = s.publish(
      next.id,
      1,
      "根据故事容量拆分全剧，每集事件与衔接" + timingFixture(),
    );
    s.db.run("UPDATE artifacts SET status='reviewed' WHERE id=?", [plan.id]);
    s.updateTask(next.id, 1, "awaiting_user");
    s.approve(next.id, 1, plan.id);
    expect(s.canRun(s.task(script.id))).toBe(true);
  });
  test("重复领取同一任务被拒绝", () => {
    const { s, t } = setup();
    s.claim(t.id, 1, {});
    expect(() => s.claim(t.id, 1, {})).toThrow();
  });
  test("中断后的旧产物不能覆盖当前修订", () => {
    const { s, t } = setup();
    s.claim(t.id, 1, {});
    s.interrupt(t.id, 1, "换成银色头发");
    expect(s.task(t.id).revision).toBe(2);
    expect(s.publish(t.id, 1, "旧结果").status).toBe("superseded");
    expect(s.updateTask(t.id, 1, "awaiting_user")).toBe(false);
  });
  test("中断自己不擅自停止其他任务", () => {
    const { s, p, t } = setup();
    const next = s.list<any>(
      "SELECT * FROM tasks WHERE projectId=? AND stage=1",
      p.id,
    )[0];
    s.updateTask(next.id, 1, "running");
    s.interrupt(t.id, 1, "修改");
    expect(s.task(next.id).status).toBe("running");
    s.invalidateAfter(s.task(t.id));
    expect(s.task(next.id).status).toBe("blocked");
  });
  test("过期审核和跨任务产物无法被批准", () => {
    const { s, t } = setup();
    const a = s.publish(t.id, 1, "旧版");
    s.db.run("UPDATE artifacts SET status='reviewed' WHERE id=?", [a.id]);
    s.interrupt(t.id, 1, "更改");
    s.updateTask(t.id, 2, "awaiting_user");
    expect(() => s.approve(t.id, 1, a.id)).toThrow();
    expect(() => s.approve(t.id, 2, a.id)).toThrow();
  });
  test("API 额度原子预留，CLI 不受预算限制", () => {
    const { s, p } = setup();
    expect(s.reserve(p.id, "one", connection)).toBeTruthy();
    expect(() => s.reserve(p.id, "two", connection)).toThrow("预算");
    expect(
      s.reserve(p.id, "cli", { ...connection, transport: "cli" }),
    ).toBeNull();
    expect(s.one<any>("SELECT COUNT(*) n FROM costs")!.n).toBe(1);
  });
  test("重启保留未知费用并使旧执行失效", () => {
    const { s, p, t } = setup();
    s.claim(t.id, 1, {});
    s.reserve(p.id, "one", connection);
    s.recover();
    expect(s.task(t.id).status).toBe("paused");
    expect(s.task(t.id).revision).toBe(2);
    expect(s.one<any>("SELECT status FROM costs")!.status).toBe("unknown");
    expect(() => s.reserve(p.id, "two", connection)).toThrow();
  });
});

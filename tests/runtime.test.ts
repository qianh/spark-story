import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/store";
import { Runtime } from "../apps/server/runtime";
import { timingFixture, inventoryFixture } from "./fixtures/timing";
import type { Connection, Task } from "../packages/domain";
import type { generate } from "../apps/server/connectors";
const resources: { root: string; s: Store; r: Runtime }[] = [];
async function fixture(generator: typeof generate) {
  const root = await mkdtemp(join(tmpdir(), "spark-runtime-test-"));
  const s = new Store(":memory:");
  const p = s.createProject({
    name: "测试作品",
    source: "雨天少女",
    inputType: "idea",
    aspect: "9:16",
    template: "cel",
    budget: 0,
  });
  const c: Connection = {
    id: "cli",
    name: "测试执行器",
    transport: "cli",
    provider: "codex",
    executable: "/test/codex",
    model: "",
    baseUrl: "",
    keyEnv: "",
    reserveCents: 0,
    health: "installed",
    version: "test",
  };
  s.saveConnection(c);
  for (const role of ["主模型", "文本模型"])
    s.db.run("INSERT INTO bindings VALUES(?,?)", [role, c.id]);
  const r = new Runtime(s, root, (...args) =>
    args[1].startsWith("你是剧情展开 Agent")
      ? Promise.resolve(JSON.stringify(inventoryFixture()))
      : generator(...args),
  );
  resources.push({ root, s, r });
  const t = s.one<Task>(
    "SELECT * FROM tasks WHERE projectId=? AND stage=0",
    p.id,
  )!;
  return { s, r, t };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw Error("运行未在预期时间内完成");
}
afterEach(async () => {
  for (const { root, s, r } of resources.splice(0)) {
    r.shutdown();
    await waitFor(() => r.active.size === 0);
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("专业产物交回主控，通过后等待用户而非自行解锁", async () => {
  let calls = 0;
  const { s, r, t } = await fixture(async () =>
    ++calls === 1
      ? "# 故事概要\n人物与冲突"
      : '{"pass":true,"feedback":"符合要求"}',
  );
  r.start(t.id, 1);
  await waitFor(() => !r.active.has(t.id));
  expect(calls).toBe(2);
  expect(s.task(t.id).status).toBe("awaiting_user");
  expect(s.one<any>("SELECT status FROM tasks WHERE stage=1")!.status).toBe(
    "blocked",
  );
});
test("超时规划即使主控总是通过也不能过关，旧规划不能启动下游", async () => {
  let calls = 0;
  const { s, r, t } = await fixture(async (_c, p) => {
    calls++;
    return p.startsWith("你是主控")
      ? '{"pass":true,"feedback":"通过"}'
      : "# 超长" + timingFixture(180);
  });
  s.updateTask(t.id, 1, "approved");
  const a = s.publish(t.id, 1, "概要");
  s.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [a.id]);
  const plan = s.one<Task>("SELECT * FROM tasks WHERE stage=1")!;
  s.updateTask(plan.id, 1, "ready");
  r.start(plan.id, 1);
  await waitFor(() => !r.active.has(plan.id));
  expect(s.task(plan.id).status).toBe("needs_user");
  expect(calls).toBe(5);
  expect(
    s.list(
      "SELECT id FROM artifacts WHERE taskId=? AND status='reviewed'",
      plan.id,
    ),
  ).toHaveLength(0);
  s.updateTask(plan.id, 1, "approved");
  const legacy = s.publish(plan.id, 1, "旧规划");
  s.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [legacy.id]);
  const script = s.one<Task>("SELECT * FROM tasks WHERE stage=2")!;
  expect(() => r.start(script.id, script.revision)).toThrow("重新规划");
});
test("分集规划通过后第一集才可执行，并将确认的规划传入剧本上下文", async () => {
  const prompts: string[] = [];
  const { s, r, t } = await fixture(async (_c, p) => {
    prompts.push(p);
    return p.startsWith("你是主控")
      ? '{"pass":true,"feedback":"通过"}'
      : "# 全剧分集规划\n第1集：雨中相遇\n第2集：谜底揭晓" + timingFixture();
  });
  s.updateTask(t.id, 1, "approved");
  const a = s.publish(t.id, 1, "整部故事概要");
  s.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [a.id]);
  const plan = s.one<Task>("SELECT * FROM tasks WHERE stage=1")!,
    script = s.one<Task>("SELECT * FROM tasks WHERE stage=2")!;
  s.updateTask(plan.id, 1, "ready");
  expect(() => r.start(script.id, 1)).toThrow("前置");
  r.start(plan.id, 1);
  await waitFor(() => !r.active.has(plan.id));
  const planPrompt = prompts.find((p) => p.startsWith("你是动漫"))!;
  expect(planPrompt).toContain("根据故事容量");
  expect(planPrompt).toContain("逐集");
  expect(planPrompt).not.toContain("写第一集的完整分场剧本");
  const reviewed = s.one<any>(
    "SELECT * FROM artifacts WHERE taskId=? AND status='reviewed'",
    plan.id,
  )!;
  s.approve(plan.id, s.task(plan.id).revision, reviewed.id);
  r.start(script.id, s.task(script.id).revision);
  await waitFor(() => !r.active.has(script.id));
  const scriptPrompt = prompts.find(
    (p) => p.startsWith("你是动漫") && p.includes("写第一集的完整分场剧本"),
  )!;
  expect(scriptPrompt).toContain("第一集");
  expect(scriptPrompt).toContain("雨中相遇");
  expect(scriptPrompt).toContain("已确认分集规划");
});
test("完成前已能看到草稿，主控审核不覆盖正文，旧修订流式回调失效", async () => {
  let finish!: () => void;
  let emit: ((text: string) => void) | undefined;
  let calls = 0;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const { s, r, t } = await fixture(
    async (_c, _p, _cwd, _signal, _event, _images, onText) => {
      if (++calls === 1) {
        emit = onText;
        onText?.("# 正在写作\n\n第一段");
        await gate;
        return "# 正在写作\n\n第一段\n\n第二段";
      }
      onText?.('{"pass":true}');
      return '{"pass":true,"feedback":"通过"}';
    },
  );
  try {
    r.start(t.id, 1);
    await waitFor(() => !!emit);
    expect((s.board(t.projectId) as any).progress[0].content).toContain(
      "第一段",
    );
    expect(s.list("SELECT * FROM artifacts")).toHaveLength(0);
    finish();
    await waitFor(() => !r.active.has(t.id));
    expect((s.board(t.projectId) as any).progress[0].content).toContain(
      "第二段",
    );
    expect((s.board(t.projectId) as any).progress[0].content).not.toContain(
      "pass",
    );
    s.interrupt(t.id, 1, "");
    emit?.("旧流式输出");
    expect((s.board(t.projectId) as any).progress[0].content).not.toContain(
      "旧流式",
    );
  } finally {
    finish();
  }
});
test("连续不合格生成四次后停止，不无限返工", async () => {
  let calls = 0;
  const { s, r, t } = await fixture(async () =>
    ++calls % 2 ? "待改进稿" : '{"pass":false,"feedback":"补足人物动机"}',
  );
  r.start(t.id, 1);
  await waitFor(() => !r.active.has(t.id));
  expect(calls).toBe(8);
  expect(s.task(t.id).status).toBe("needs_user");
  expect(s.task(t.id).round).toBe(3);
});
test("用户直接编辑交给主控审核，不重新生成覆盖", async () => {
  const prompts: string[] = [];
  const { s, r, t } = await fixture(async (_c, p) => {
    prompts.push(p);
    return '{"pass":true,"feedback":"修改符合要求"}';
  });
  s.interrupt(t.id, 1, "");
  s.db.run("UPDATE interventions SET status='paused'");
  s.updateTask(t.id, 2, "paused");
  s.publish(t.id, 2, "用户精确修改的剧本");
  r.start(t.id, 2);
  await waitFor(() => !r.active.has(t.id));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("用户精确修改的剧本");
  expect(s.task(t.id).status).toBe("awaiting_user");
});
test("模糊反馈形成方案且等待用户，开始按钮不能绕过确认", async () => {
  const { s, r, t } = await fixture(
    async () =>
      '{"clear":false,"instruction":"加强开场冲突","explanation":"用户仅表达了不满意，需要确认具体方向"}',
  );
  r.intervene(t.id, 1, "不够好");
  await waitFor(() => s.task(t.id).status === "needs_user");
  expect(() => r.start(t.id, 2)).toThrow("确认");
  expect(s.one<any>("SELECT status FROM interventions")!.status).toBe(
    "awaiting_confirmation",
  );
});

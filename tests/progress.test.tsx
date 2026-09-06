import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaskActivity,
  LiveDraft,
  StoryProgress,
  latestCheckpoints,
} from "../apps/web/TaskActivity";
import { outlineFixture } from "./fixtures/series";
import { ProgressTracker } from "../apps/server/progress";
import { Store } from "../apps/server/store";
import type { Task, Connection } from "../packages/domain";
import type { TaskProgress } from "../packages/progress";
const task = {
  id: "task",
  revision: 1,
  status: "running",
  stage: 0,
  role: "剧情 Agent",
  updatedAt: new Date().toISOString(),
} as Task;
const progress = {
  taskId: "task",
  revision: 1,
  phase: "generate",
  actor: "剧情 Agent",
  model: "Grok Build",
  content: "",
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  outputAt: "",
  status: "running",
} as TaskProgress;
test("状态面板区分等待首字、生成、审核、断线和无心跳", () => {
  expect(renderToStaticMarkup(<TaskActivity task={task} />)).toContain(
    "等待模型首段输出",
  );
  expect(
    renderToStaticMarkup(
      <TaskActivity
        task={task}
        progress={{ ...progress, outputAt: new Date().toISOString() }}
      />,
    ),
  ).toContain("继续生成");
  expect(
    renderToStaticMarkup(
      <TaskActivity
        task={{ ...task, status: "reviewing" }}
        progress={progress}
      />,
    ),
  ).toContain("你可以先阅读");
  expect(
    renderToStaticMarkup(
      <TaskActivity
        task={{ ...task, status: "coordinating" }}
        progress={progress}
      />,
    ),
  ).toContain("判断修改范围");
  expect(
    renderToStaticMarkup(
      <TaskActivity task={task} progress={progress} offline />,
    ),
  ).toContain("连接断开");
  expect(
    renderToStaticMarkup(
      <TaskActivity
        task={task}
        progress={{ ...progress, heartbeatAt: "2020-01-01" }}
      />,
    ),
  ).toContain("心跳暂未更新");
  expect(
    renderToStaticMarkup(
      <TaskActivity task={{ ...task, status: "approved" }} />,
    ),
  ).toBe("");
  expect(renderToStaticMarkup(<LiveDraft content="" />)).toContain(
    "等待第一段正文",
  );
  expect(
    renderToStaticMarkup(<LiveDraft content="# 草稿" active={false} />),
  ).toContain("中断前草稿");
});
test("同名检查点只保留最新状态，不被更早的候选覆盖", () => {
  const html = renderToStaticMarkup(
    <StoryProgress
      outline={outlineFixture}
      checkpoints={latestCheckpoints(
        [
          {
            taskId: "t",
            revision: 1,
            kind: "故事结构",
            status: "reviewed",
            content: "",
          },
          {
            taskId: "t",
            revision: 1,
            kind: "故事结构",
            status: "candidate",
            content: "",
          },
          {
            taskId: "t",
            revision: 1,
            kind: "章节 CH001",
            status: "reviewed",
            content: "",
          },
          {
            taskId: "t",
            revision: 1,
            kind: "章节 CH001",
            status: "candidate",
            content: "",
          },
        ],
        "t",
        1,
      )}
      currentKind="章节 CH002"
    />,
  );
  expect(html).toContain("1 / 2 章已通过");
  expect(html).toContain("故事结构 · 已通过");
  expect(html).toContain("雨中相遇 · 已通过");
  expect(html).toContain("当前 章节 CH002 · 生成中");
});
test("完整故事稿进度直接列出结构、各章状态和当前步骤", () => {
  const html = renderToStaticMarkup(
    <StoryProgress
      outline={outlineFixture}
      checkpoints={[
        { kind: "故事结构", status: "reviewed" },
        { kind: "章节 CH001", status: "candidate" },
      ]}
      currentKind="章节 CH001"
    />,
  );
  expect(html).toContain("执行进度");
  expect(html).toContain("0 / 2 章已通过");
  expect(html).toContain("故事结构");
  expect(html).toContain("已通过");
  expect(html).toContain("CH001");
  expect(html).toContain("待审核");
  expect(html).toContain("CH002");
  expect(html).toContain("未开始");
  expect(html).toContain("当前 章节 CH001");
});
test("进度持久化，结束和旧修订不能继续写，重启保留草稿并标中断", () => {
  const s = new Store(":memory:");
  const p = s.createProject({
    name: "测试",
    source: "故事",
    inputType: "idea",
    aspect: "9:16",
    template: "cel",
    budget: 0,
  });
  const t = s.one<Task>("SELECT * FROM tasks WHERE stage=0")!;
  s.updateTask(t.id, 1, "running");
  const tracker = new ProgressTracker(s, t, { name: "CLI" } as Connection);
  try {
    tracker.text("# 初稿");
    expect((s.board(p.id) as any).progress[0].content).toBe("# 初稿");
    tracker.text("# 后稿");
    tracker.finish("completed");
    tracker.text("不再写入");
    expect((s.board(p.id) as any).progress[0].content).toBe("# 后稿");
    const next = new ProgressTracker(s, t, { name: "CLI" } as Connection);
    next.text("重启草稿");
    s.recover();
    next.text("旧进程");
    next.finish("interrupted");
    expect((s.board(p.id) as any).progress[0].content).toBe("重启草稿");
    expect((s.board(p.id) as any).progress[0].status).toBe("interrupted");
  } finally {
    tracker.finish("completed");
    s.db.close();
  }
});

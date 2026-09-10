import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaskActivity,
  LiveDraft,
  StoryProgress,
  latestCheckpoints,
} from "../apps/web/TaskActivity";
import {
  SeriesPlanningProgress,
  completedEpisodes,
  scriptText,
} from "../apps/web/SeriesPlanningProgress";
import { planFixture, outlineFixture } from "./fixtures/series";
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
test("媒体审核展示真实计数、当前产物和累计耗时，旧修订不展示", () => {
  const reviewing = { ...task, stage: 3, status: "reviewing" } as Task;
  const p: TaskProgress = {
    ...progress,
    review: {
      startedAt: new Date(Date.now() - 125000).toISOString(),
      step: "visual", current: "窥伺影", speechDone: 1, speechTotal: 1,
      visualDone: 3, visualTotal: 8, summaryDone: false,
    },
  };
  const html = renderToStaticMarkup(<TaskActivity task={reviewing} progress={p} />);
  expect(html).toContain("声音转写 1 / 1 项已完成");
  expect(html).toContain("图片 / 视频审核 3 / 8 项已完成");
  expect(html).toContain("窥伺影");
  expect(html).toContain("汇总审核：待开始");
  expect(html).toContain("审核累计 2 分");
  const summary = renderToStaticMarkup(<TaskActivity task={reviewing} progress={{ ...p, review: { ...p.review!, step: "summary", current: "汇总", visualDone: 8, speechTotal: 0, speechDone: 0 } }} />);
  expect(summary).toContain("汇总审核：进行中");
  expect(summary).toContain("无需转写");
  expect(renderToStaticMarkup(<TaskActivity task={reviewing} progress={{ ...p, revision: 0 }} />)).not.toContain("媒体审核进度");
});
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
    const resumed = s.task(t.id);
    s.db.run("INSERT INTO media_review_progress VALUES(?,?,?)", [t.id, resumed.revision, JSON.stringify({ current: "沈不言" })]);
    s.updateTask(t.id, resumed.revision, "reviewing");
    const reviewCall = new ProgressTracker(s, resumed, { name: "CLI" } as Connection);
    reviewCall.finish("completed");
    expect((s.board(p.id) as any).progress[0].review.current).toBe("沈不言");
    s.db.run("UPDATE media_review_progress SET revision=0 WHERE taskId=?", [t.id]);
    expect((s.board(p.id) as any).progress[0].review).toBeUndefined();
  } finally {
    tracker.finish("completed");
    s.db.close();
  }
});

test("分集返工期间保留完整候选、审核意见及当前已返回的单集", () => {
  const content = JSON.stringify(planFixture);
  const checkpoints = [
    {
      taskId: "task",
      revision: 1,
      kind: "全剧分集边界",
      status: "rejected",
      content,
      createdAt: "2026-09-06T13:00:00Z",
    },
    {
      taskId: "task",
      revision: 1,
      kind: "全剧分集边界",
      status: "candidate",
      content,
      createdAt: "2026-09-06T12:00:00Z",
    },
    {
      taskId: "task",
      revision: 0,
      kind: "全剧分集边界",
      status: "reviewed",
      content: "旧修订方案",
    },
  ];
  const html = renderToStaticMarkup(
    <SeriesPlanningProgress
      task={task}
      checkpoints={checkpoints}
      events={[
        {
          seq: 1,
          taskId: "task",
          projectId: "p",
          type: "workflow.part.failed",
          message: "请修正第二集边界",
          createdAt: "2026-09-06T13:00:01Z",
        },
      ]}
      liveContent={
        '{"episodes":[' +
        JSON.stringify(planFixture.episodes[0]) +
        ',{"id":"EP002"'
      }
    />,
  );
  expect(html).toContain("根据反馈返工中");
  expect(html).toContain("片段尝试 2 / 3");
  expect(html).toContain("请修正第二集边界");
  expect(html).toContain("真相揭晓");
  expect(html).toContain("本次输出已有 1 集内容完整");
  expect(html).not.toContain("旧修订方案");
  expect(html).not.toContain("此前保存的方案");
  for (const status of [
    "reviewing",
    "provider_blocked",
    "needs_user",
    "awaiting_user",
  ] as const) {
    const paused = renderToStaticMarkup(
      <SeriesPlanningProgress
        task={{ ...task, status }}
        checkpoints={checkpoints}
        events={[]}
        liveContent=""
      />,
    );
    expect(paused).toContain("真相揭晓");
    expect(paused).not.toContain("本次生成已完整返回");
  }
});

test("实时分集只展示完整且有效的对象，支持字符串中的括号和转义", () => {
  const ep = {
    ...planFixture.episodes[0],
    summary: '她说："关门}"，留下了\\记号',
  };
  expect(
    completedEpisodes('{"episodes":[' + JSON.stringify(ep) + ',{"id":'),
  ).toEqual([ep]);
  expect(completedEpisodes("模型正在分析，尚无 JSON")).toEqual([]);
  expect(completedEpisodes('{"episodes":[{"id":"EP001"}')).toEqual([]);
  expect(completedEpisodes(JSON.stringify(planFixture))).toEqual(
    planFixture.episodes,
  );
});

test("单集剧本返工时可读已保存正文，按当前集和修订展示进度", () => {
  const html = renderToStaticMarkup(
    <SeriesPlanningProgress
      task={{ ...task, stage: 2, episode: 2 }}
      checkpoints={[
        {
          taskId: task.id,
          revision: 1,
          kind: "单集剧本 EP002",
          status: "rejected",
          content: JSON.stringify({
            content: "# 第二集已生成正文\n她打开了信封。",
          }),
        },
        {
          taskId: task.id,
          revision: 1,
          kind: "单集剧本 EP001",
          status: "reviewed",
          content: "第一集不可混入",
        },
        {
          taskId: task.id,
          revision: 0,
          kind: "单集剧本 EP002",
          status: "reviewed",
          content: "旧修订不可混入",
        },
      ]}
      events={[]}
      liveContent=""
    />,
  );
  expect(html).toContain("单集剧本进度");
  expect(html).toContain("根据反馈返工中");
  expect(html).toContain("片段尝试 2 / 3");
  expect(html).toContain("<h1>第二集已生成正文</h1>");
  expect(html).toContain("她打开了信封。");
  expect(html).not.toContain("不可混入");
});

test("单集剧本流式正文解码换行、引号及 Unicode，并忽略未完成转义", () => {
  expect(scriptText('{"content":"# 场一\\n她说：\\"你好\\"')).toBe(
    '# 场一\n她说："你好"',
  );
  expect(scriptText('{"content":"正文\\u4f60\\u597d\\u12')).toBe("正文你好");
  expect(scriptText('{"content":"正文\\')).toBe("正文");
  expect(scriptText(JSON.stringify({ content: "# 完整正文\n结束" }))).toBe(
    "# 完整正文\n结束",
  );
  expect(scriptText("# 普通正文")).toBe("# 普通正文");
});

test("文字分镜显示已保存镜头、实际尝试和执行耗时", () => {
  const html = renderToStaticMarkup(
    <SeriesPlanningProgress
      task={{ ...task, stage: 8, episode: 1 }}
      checkpoints={[
        {
          taskId: task.id,
          revision: 1,
          kind: "文字分镜 EP001",
          status: "rejected",
          createdAt: "2026-09-06T12:00:00Z",
          content: JSON.stringify({
            summary: "分镜方案",
            shots: [
              {
                id: "SH001",
                title: "抱起幼女",
                prompt: "女孩仍在怀中",
                duration: 5,
                assetIds: ["girl"],
              },
            ],
          }),
        },
      ]}
      events={[
        {
          seq: 3,
          taskId: task.id,
          projectId: "p",
          type: "workflow.metrics",
          message: "审核耗时 12 秒",
          createdAt: "2026-09-06T12:01:00Z",
        },
      ]}
      liveContent=""
    />,
  );
  expect(html).toContain("文字分镜进度");
  expect(html).toContain("片段尝试 2 / 3");
  expect(html).toContain("抱起幼女");
  expect(html).toContain("审核耗时 12 秒");
});

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectorOrb } from "../apps/web/DirectorOrb";

const board = {
  events: [
    {
      seq: 1,
      type: "master.message",
      message: "身份事实变了，须从故事稿改起",
      createdAt: "",
      projectId: "p",
      taskId: "t",
    },
  ],
  interventions: [
    {
      id: "i1",
      status: "awaiting_confirmation",
      proposal: JSON.stringify({
        clear: true,
        instruction: "药童改为男童",
        explanation: "须从故事稿改起",
        change: [{ action: "revise_story", title: "完整故事稿中的药童" }],
        invalidate: [],
        keep: [],
      }),
    },
  ],
};

test("主控悬浮球默认只露入口，不占滚动区", () => {
  const html = renderToStaticMarkup(
    <DirectorOrb
      board={board as any}
      task={{ id: "t", revision: 1, title: "定妆与资产" } as any}
      busy={false}
      onSend={async () => {}}
      onConfirm={async () => {}}
    />,
  );
  expect(html).toContain('aria-label="打开主控"');
  expect(html).not.toContain("给主控的修改意见");
  expect(html).toContain("1");
});

test("点开悬浮球后可以口述并看到待确认方案", () => {
  const html = renderToStaticMarkup(
    <DirectorOrb
      open
      board={board as any}
      task={{ id: "t", revision: 1, title: "定妆与资产" } as any}
      busy={false}
      onSend={async () => {}}
      onConfirm={async () => {}}
    />,
  );
  expect(html).toContain("给主控的修改意见");
  expect(html).toContain("药童改成男童");
  expect(html).toContain("确认并执行");
  expect(html).toContain("完整故事稿中的药童");
  expect(html).toContain("当前：定妆与资产");
  expect(html).not.toContain("身份事实变了，须从故事稿改起");
});

test("执行已确认方案时说明主控在改稿，不是暂停", () => {
  const html = renderToStaticMarkup(
    <DirectorOrb
      open
      board={{ events: [], interventions: [] } as any}
      task={{ id: "t", revision: 1, title: "定妆与资产", status: "coordinating" } as any}
      busy
      onSend={async () => {}}
      onConfirm={async () => {}}
    />,
  );
  expect(html).toContain("主控正在按已确认的方案改设定");
  expect(html).not.toContain("已暂停");
});

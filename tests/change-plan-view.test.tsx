import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangePlanView } from "../apps/web/ChangePlanView";

test("主控评估展示将改、作废和保留", () => {
  const html = renderToStaticMarkup(
    <ChangePlanView
      proposal={JSON.stringify({
        clear: true,
        instruction: "药童改为男童",
        explanation: "身份事实变了，须从故事稿改起",
        origin: "story",
        change: [{ action: "revise_story", title: "完整故事稿中的药童" }],
        invalidate: [{ title: "含药童的分镜", reason: "画面仍是女童" }],
        keep: [{ title: "故事概要", reason: "未写性别" }],
      })}
      busy={false}
      onConfirm={() => {}}
    />,
  );
  expect(html).toContain("主控评估");
  expect(html).toContain("将改");
  expect(html).toContain("完整故事稿中的药童");
  expect(html).toContain("将作废");
  expect(html).toContain("将保留");
  expect(html).toContain("确认并执行");
});

import { expect, test } from "bun:test";
import {
  assertChangePlan,
  changePlanSchema,
  looksWithoutUpstream,
} from "../packages/change-plan";

test("只改提示词或只重出图不合法", () => {
  const promptOnly = changePlanSchema.parse({
    clear: true,
    instruction: "药童改成男童",
    explanation: "重写提示词并出图",
    origin: "story",
    change: [
      { action: "revise_asset_prompt", targetId: "yaotong:child", title: "药童提示词" },
      { action: "regenerate_asset", targetId: "yaotong:child", title: "药童定妆" },
    ],
  });
  expect(looksWithoutUpstream(promptOnly)).toBe(true);
  expect(() => assertChangePlan(promptOnly)).toThrow("不允许只改提示词或只重出图");
});

test("女童改男童必须改设定、剧情和定妆，且不改无关前置", () => {
  const plan = changePlanSchema.parse({
    clear: true,
    instruction: "药童改为男童，并同步剧情、设定与定妆",
    explanation: "身份事实变了，须从故事稿改起",
    origin: "story",
    change: [
      { action: "revise_story", title: "完整故事稿中的药童" },
      { action: "revise_look_registry", targetId: "yaotong", title: "药童外观登记" },
      { action: "revise_episode_script", targetId: "EP001", title: "第1集剧本" },
      { action: "revise_asset_prompt", targetId: "yaotong:child", title: "药童定妆提示词" },
      { action: "regenerate_asset", targetId: "yaotong:child", title: "药童定妆图" },
    ],
    invalidate: [{ title: "含药童的分镜与成片", reason: "画面仍是女童" }],
    keep: [
      { title: "故事概要", reason: "未写性别" },
      { title: "沈不言定妆", reason: "未涉及" },
    ],
  });
  expect(() => assertChangePlan(plan)).not.toThrow();
  expect(looksWithoutUpstream(plan)).toBe(false);
});

test("origin 之前的步骤不能被改", () => {
  expect(() =>
    assertChangePlan(
      changePlanSchema.parse({
        clear: true,
        instruction: "只改第1集称呼",
        explanation: "故事设定已是男童",
        origin: "script",
        change: [
          { action: "revise_story", title: "不该回头改故事" },
          { action: "revise_episode_script", targetId: "EP001", title: "第1集" },
        ],
      }),
    ),
  ).toThrow("不影响该流程前置");
});

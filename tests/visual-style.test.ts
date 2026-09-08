import { test, expect } from "bun:test";
import { templates } from "../packages/domain";
import {
  assetVisualPrompt,
  donghuaStylePrompt,
} from "../packages/visual-style";

test("三维仙侠模板只规定画风，不强加案例人物的身份服饰和情绪", () => {
  const donghua = templates.find((t) => t.id === "donghua3d")!;
  expect(donghua.prompt).toBe(donghuaStylePrompt);
  expect(donghuaStylePrompt).toContain("《仙逆》动画的三维国漫画风");
  expect(donghuaStylePrompt).toContain("超写实面部与皮肤");
  for (const content of ["高冷", "银白", "玉佩", "流苏", "成年男性", "仙山", "雨夜"])
    expect(donghuaStylePrompt).not.toContain(content);
});

test("完整画面描述只拼接一次，不重复身份状态，不添加剧情天气", () => {
  const p = assetVisualPrompt({ id: "donghua3d", prompt: donghuaStylePrompt }, {
    kind: "character", promptFormat: "visual-description-v1",
    prompt: "黑发青年，青黑素袍完好干燥，温和站立。",
    identity: "黑发青年", state: "青黑素袍完好干燥",
  });
  expect(p.split("黑发青年")).toHaveLength(2);
  expect(p.split("青黑素袍完好干燥")).toHaveLength(2);
  expect(p).not.toContain("雨夜");
  expect(p).not.toContain("湿衣");
  expect(p).toContain("全身从头到脚完整入镜");
});

test("国漫角色资产按全身定妆照生成，清理旧渲染要求，身份状态仍由资产决定", () => {
  const a = {
    kind: "character",
    prompt:
      "影视级虚幻引擎写实渲染。姿态：左手扶剑，右手垂下。身份：成年男性。",
    identity: "成年男性青衫",
    state: "衣服湿透",
  };
  const p = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    a,
  );
  expect(p.startsWith("高细节3D CGI仙侠全身定妆照")).toBe(true);
  expect(p).toContain("单角色全身定妆");
  expect(p).toContain("全身从头到脚完整入镜");
  expect(p).toContain("左手扶剑，右手垂下");
  expect(p).toContain("成年男性青衫");
  expect(p).toContain("衣服湿透");
  expect(p).not.toContain("影视级虚幻引擎写实渲染");
  expect(
    assetVisualPrompt(
      { id: "donghua3d", prompt: donghuaStylePrompt },
      { ...a, kind: "scene" },
    ),
  ).not.toContain("单角色全身定妆");
  expect(assetVisualPrompt({ id: "cel", prompt: "赛璐璐" }, a)).toContain(
    a.prompt,
  );
});

test("已有独立佩剑资产时，角色定妆不画剑", () => {
  const shen = {
    kind: "character",
    name: "沈不言",
    prompt: "姿态：左手松扣剑格但剑未出，右手垂下。",
    identity: "青梧宗青年剑修。腰素绦，左肋素鞘长剑。",
    state: "基础定妆。剑在腰侧未出。",
  };
  const sword = {
    kind: "prop",
    name: "沈不言佩剑",
    prompt: "素鞘长剑",
    identity: "沈不言腰侧素鞘长剑。",
    state: "完整剑与鞘",
  };
  const robe = {
    kind: "prop",
    name: "沈不言外袍",
    prompt: "青黑外袍",
    identity: "沈不言外袍",
    state: "空袍",
  };
  const p = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    shen,
    [shen, sword, robe],
  );
  expect(p).toContain("已有独立道具：沈不言佩剑");
  expect(p).toContain("角色定妆不画这些物件");
  expect(p).toContain("腰侧无剑");
  expect(p).not.toContain("左肋素鞘长剑");
  expect(p).not.toContain("松扣剑格");
  expect(p).not.toContain("剑在腰侧未出");
  expect(p).toContain("青年剑修");
  expect(p).not.toContain("沈不言外袍");
});

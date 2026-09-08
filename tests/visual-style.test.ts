import { test, expect } from "bun:test";
import { templates } from "../packages/domain";
import {
  assetLookAgentPrompt,
  assetVisualPrompt,
  assertCanonicalLooks,
  assertSceneContent,
  characterContentTemplate,
  characterSheetModule,
  donghuaStylePrompt,
  lookPlotIssues,
  propContentTemplate,
  propSheetModule,
  sceneContentTemplate,
  sceneSheetModule,
  sharedStyleDna,
} from "../packages/visual-style";

test("仙侠模板保存公共画风 DNA 和三套模块", () => {
  const t = templates.find((x) => x.id === "donghua3d")!;
  expect(t.prompt).toBe(sharedStyleDna);
  expect(donghuaStylePrompt).toBe(sharedStyleDna);
  expect(donghuaStylePrompt.startsWith("SHARED STYLE DNA —")).toBe(true);
  expect(t.description).toContain("公共画风 DNA");
});

const filledContent = characterContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledProp = propContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledScene = sceneContentTemplate
  .replace("Place: [mountain gate / cliff pavilion / inner meditation hall / bamboo courtyard / stone stair]", "Place: mountain gate")
  .replace("Space: [what is near camera, what is mid, what is far]", "Space: steps near, gate mid, trees far")
  .replace("Key structures: [roof type, columns, railings, stone steps, screens]", "Key structures: timber columns, stone steps")
  .replace("Materials on site: [grey granite, dark timber, grey tile, paper windows]", "Materials on site: grey granite, dark timber")
  .replace("Set dressing: [one incense table / hanging lantern / sword rack / none]", "Set dressing: none")
  .replace("Atmosphere: [still dry air / ordinary distant haze]", "Atmosphere: still dry air")
  .replace("Camera: [wide establishing / medium courtyard / looking down a corridor]", "Camera: wide establishing");

test("角色定妆按 DNA + 人物模块 + CONTENT 拼接，不改 DNA", () => {
  const content = filledContent.replace(
    "Subject: none",
    "Subject: young Chinese male disciple Shen Buyan",
  );
  const prompt = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    {
      name: "沈不言",
      kind: "character",
      promptFormat: "character-content-v1",
      prompt: content,
      identity: "不得重复的身份元数据",
      state: "不得重复的状态元数据",
    },
  );
  expect(prompt).toBe(
    `${sharedStyleDna}\n\n${characterSheetModule}\n\n${content}`,
  );
  expect(prompt).not.toContain("不得重复的身份元数据");
  expect(() =>
    assetVisualPrompt(
      { id: "donghua3d", prompt: donghuaStylePrompt },
      { kind: "character", prompt: characterContentTemplate, identity: "", state: "" },
    ),
  ).toThrow();
});

test("场景和道具用同一 DNA，不用人物浅景模块", () => {
  const scene = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    {
      kind: "scene",
      promptFormat: "scene-content-v1",
      prompt: filledScene,
      identity: "",
      state: "",
    },
  );
  expect(scene.startsWith(sharedStyleDna)).toBe(true);
  expect(scene).toContain(sceneSheetModule);
  expect(scene).toContain(filledScene);
  expect(scene).not.toContain("CHARACTER SHEET");
  expect(scene).not.toContain("taupe-gray studio backdrop");
  const prop = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    {
      kind: "prop",
      promptFormat: "prop-content-v1",
      prompt: filledProp,
      identity: "",
      state: "",
    },
  );
  expect(prop).toContain(propSheetModule);
  expect(prop).not.toContain("CHARACTER SHEET");
  expect(() =>
    assertSceneContent(
      filledScene.replace(
        "Time / weather: default dry daylight — do not fill night, rain, or lamps-off",
        "Time / weather: light rain",
      ),
    ),
  ).toThrow(/白天/);
});

test("完整画面描述只拼接一次，不重复身份状态，不添加剧情天气", () => {
  const p = assetVisualPrompt(
    { id: "fresh", prompt: "清新动漫" },
    {
      kind: "character",
      promptFormat: "visual-description-v1",
      prompt: "黑发青年，青黑素袍完好干燥，温和站立。",
      identity: "黑发青年",
      state: "青黑素袍完好干燥",
    },
  );
  expect(p.split("黑发青年")).toHaveLength(2);
  expect(p.split("青黑素袍完好干燥")).toHaveLength(2);
  expect(p).not.toContain("雨夜");
  expect(p).toContain("全身从头到脚完整入镜");
});

test("已有独立佩剑资产时，角色 CONTENT 不画剑", () => {
  const content = filledContent
    .replace("Subject: none", "Subject: young Chinese male disciple")
    .replace("- Unique accessories: none", "- Unique accessories: sheathed sword");
  const shen = {
    kind: "character" as const,
    name: "沈不言",
    promptFormat: "character-content-v1" as const,
    prompt: content,
    identity: "青梧宗青年剑修。腰素绦，左肋素鞘长剑。",
    state: "基础定妆。剑在腰侧未出。",
  };
  const sword = {
    kind: "prop" as const,
    name: "沈不言佩剑",
    prompt: filledProp,
    identity: "沈不言腰侧素鞘长剑。",
    state: "完整剑与鞘",
  };
  const p = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    shen,
    [shen, sword],
  );
  expect(p).toContain("Unique accessories: no weapon");
  expect(p).not.toContain("sheathed sword");
  expect(p).not.toContain("左肋素鞘长剑");
});

test("资产 Agent 按登记填写模板，不写本集天气", () => {
  const p = assetLookAgentPrompt(donghuaStylePrompt, "[]", "[]");
  expect(p).toContain("外观登记");
  expect(p).toContain("character-content-v1");
  expect(p).toContain("scene-content-v1");
  expect(p).toContain("禁止夜雨");
  expect(p).toContain(characterContentTemplate.slice(0, 20));
});

test("定妆验收拦住雨夜、高烧、闭眼", () => {
  expect(
    lookPlotIssues({
      name: "雨巷",
      prompt: "青石巷，两侧旧墙，地面可见，清晰日光。",
      identity: "雨巷",
      state: "基础外观。建筑完好干燥。",
    }),
  ).toEqual([]);
  const fever = lookPlotIssues({
    name: "病弱幼女",
    prompt: filledContent,
    identity: "未命名病弱幼女",
    state: "高烧额红，双眼紧闭",
  });
  expect(fever.join("；")).toMatch(/高烧|额红|双眼紧闭/);
  expect(() =>
    assertCanonicalLooks([
      {
        name: "窥伺影",
        prompt: "人形暗影立于秋雨湿雾中。",
        identity: "空脸窥伺影",
        state: "立于秋雨中。",
      },
    ]),
  ).toThrow(/制作验收/);
});

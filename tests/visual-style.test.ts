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
  donghuaStyleVersion,
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
  expect(donghuaStyleVersion).toBe("xianxia-style-dna-v3");
  expect(sharedStyleDna).toContain("not live-action documentary");
  expect(sharedStyleDna).toContain("Photoreal surface detail only as material finish");
  expect(sharedStyleDna).not.toContain("High-finish 3D photorealistic cinematic");
  expect(sharedStyleDna).not.toContain("photoreal 3D, not anime");
  expect(characterSheetModule).toContain("multi-layer traditional xianxia tailoring");
  expect(propSheetModule).toContain("designed fictional artifact");
  expect(propSheetModule).toContain("not a museum antique photo");
  expect(sceneSheetModule).toContain("constructed sect location");
  expect(sceneSheetModule).toContain("not an existing mountain scenic spot");
});

const filledContent = characterContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledProp = propContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledScene = sceneContentTemplate.replace(/\[[^\]]+\]/g, "none");

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
  expect(prop).toContain("CONTENT — PROP");
  expect(scene).toContain("CONTENT — SCENE");
  expect(() =>
    assertSceneContent(
      filledScene.replace(
        "Near camera: none",
        "Near camera: simple ordinary tourist gate at a real temple",
      ),
    ),
  ).toThrow(/用词/);
});

test("场景允许在 CONTENT 末行加入远处人物，不换回人物模块", () => {
  const withFigure = `${filledScene}\nOne distant figure in series costume, small in frame, not a portrait.`;
  expect(() => assertSceneContent(withFigure)).not.toThrow();
  const prompt = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    {
      kind: "scene",
      promptFormat: "scene-content-v1",
      prompt: withFigure,
      identity: "",
      state: "",
    },
  );
  expect(prompt).toContain(sceneSheetModule);
  expect(prompt).not.toContain("CHARACTER SHEET");
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
    .replace("- Other accessories: none", "- Other accessories: sheathed sword");
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
  expect(p).toContain("Other accessories: no weapon");
  expect(p).not.toContain("sheathed sword");
  expect(p).not.toContain("左肋素鞘长剑");
});

test("资产 Agent 按登记填写模板，不写本集天气", () => {
  const p = assetLookAgentPrompt(donghuaStylePrompt, "[]", "[]");
  expect(p).toContain("外观登记");
  expect(p).toContain("character-content-v1");
  expect(p).toContain("scene-content-v1");
  expect(p).toContain("禁止夜雨");
  expect(p).toContain("CONTENT — CHARACTER");
  expect(p).toContain("CONTENT — PROP");
  expect(p).toContain("CONTENT — SCENE");
  expect(p).toContain("门外、末阶等视图不要单独建资产");
  expect(p).toContain("monumental");
  expect(p).toContain("sect artifact");
  expect(p).toContain("photorealistic landscape");
  expect(p).toContain("museum antique");
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

test("旧版三类 CONTENT 可继续用于定妆和单张重生成", () => {
  const character = characterContentTemplate.replace(/\[[^\]]+\]/g, "none")
    .replace("CONTENT — CHARACTER (fill per role):", "CONTENT — replace per character:")
    .replace("Costume:", "Costume specific to this character:")
    .replace("- Embroidery:", "- Embroidery motif:")
    .replace("- Waist:", "- Sash and waist:")
    .replace("- Other accessories:", "- Unique accessories:");
  const prop = propContentTemplate.replace(/\[[^\]]+\]/g, "none")
    .replace("CONTENT — PROP (fill per item):", "PROP CONTENT:");
  const scene = `SCENE CONTENT:
Place: mountain gate
Time / weather: default dry daylight — do not fill night, rain, or lamps-off
Space: courtyard in front, hall behind
Key structures: carved columns
Materials on site: grey granite
Set dressing: none
Atmosphere: ordinary distant haze
People: none
Camera: wide establishing`;
  for (const [kind, prompt] of [["character", character], ["prop", prop], ["scene", scene]] as const) {
    const output = assetVisualPrompt({ id: "donghua3d", prompt: sharedStyleDna }, {
      kind, prompt, promptFormat: `${kind}-content-v1`, identity: "", state: "",
    });
    expect(output).toContain(`CONTENT — ${kind.toUpperCase()}`);
    if (kind === "scene") {
      expect(output).toContain("courtyard in front, hall behind");
      expect(output).toContain("carved columns");
      expect(output).toContain("grey granite");
    }
  }
});

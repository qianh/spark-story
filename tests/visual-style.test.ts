import { test, expect } from "bun:test";
import { templates } from "../packages/domain";
import {
  assetLookAgentPrompt,
  assetVisualPrompt,
  assertCanonicalLooks,
  assertSceneContent,
  characterContentTemplate,
  characterIdentityRule,
  emptySceneRule,
  characterSheetModule,
  donghuaStylePrompt,
  donghuaStyleVersion,
  lookPlotIssues,
  propContentTemplate,
  propSheetModule,
  sceneContentTemplate,
  sceneSheetModule,
  sharedStyleDna,
  productionVisualPrompt,
  visualReviewPrompt,
} from "../packages/visual-style";

test("所有画风的资产内容与验收均遵循选择，不向水墨或Q版注入仙侠三维规则", () => {
  for (const style of templates) {
    const prompt = assetLookAgentPrompt(style.prompt, "[]", "全剧登记");
    expect(prompt).toContain(style.prompt);
    expect(prompt).toContain("全剧登记");
    expect(prompt).not.toContain("从文字分镜 assetIds 提取");
    expect(prompt).not.toContain("不要改写成二维插画、水墨、赛璐璐或Q版");
    const review = visualReviewPrompt(style);
    expect(review).toContain(style.prompt);
    if (style.id !== "donghua3d") expect(review).not.toContain("仙侠");
  }
});

test("通用仙侠画风与三种资产类型使用新原文", () => {
  const t = templates.find((x) => x.id === "donghua3d")!;
  expect(t.prompt).toBe(sharedStyleDna);
  expect(donghuaStylePrompt.startsWith("UNIVERSAL XIANXIA STYLE\n")).toBe(true);
  expect(donghuaStyleVersion).toBe("xianxia-universal-v2");
  expect(sharedStyleDna).toContain("fabric lifted as if by mountain wind even when the figure stands still.");
  expect(sharedStyleDna).toContain("Air: faint luminous mist, never a dead brown studio void.");
  expect(sharedStyleDna).not.toMatch(/doll-smooth|taupe-gray|SAME SERIES STAGE|XIANXIA DONGHUA LOOK/);
  expect(characterSheetModule).toBe("ASSET: character sheet. Full-body standing, three-quarter, feet visible, pale mist studio. One person.");
  expect(propSheetModule).toBe("ASSET: hero prop. One object, three-quarter, pale mist studio or single dark wood slab.");
  expect(sceneSheetModule).toBe("ASSET: donghua set plate. Monumental xianxia architecture, flying eaves, dougong, ceremonial stairs, designed mist, empty set.");
});

const filledContent = characterContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledProp = propContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledScene = sceneContentTemplate.replace(/\[[^\]]+\]/g, "none");

test("作品保存的画风与模块原样用于生图和审核，不以内部 DNA 覆盖", () => {
  const style = {
    id: "donghua3d", version: "user-selected-v1", prompt: "用户选择的画风原文",
    characterModule: "用户的人物构图", propModule: "用户的道具构图", sceneModule: "用户的场景构图",
  };
  for (const kind of ["character", "prop", "scene"]) {
    const content = kind === "character" ? filledContent : "已确认的资产内容";
    const result = assetVisualPrompt(style, { kind, prompt: content, identity: "", state: "" });
    expect(result.startsWith(style.prompt + "\n\n")).toBe(true);
    expect(result).not.toContain(sharedStyleDna);
    expect(result).toContain(kind === "character" ? style.characterModule : kind === "prop" ? style.propModule : style.sceneModule);
  }
  expect(productionVisualPrompt(style)).toBe(style.prompt);
  expect(productionVisualPrompt({ id: "donghua3d", prompt: "STYLE LOCK — 用户原文" })).toBe("STYLE LOCK — 用户原文");
});

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
    `${sharedStyleDna}\n\n${characterSheetModule}\n\n${characterIdentityRule}\n${content}`,
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
  expect(scene).not.toContain("SAME SERIES STAGE");
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

test("场景定妆拒绝旧版远处人物例外与有人的 People 字段", () => {
  expect(() => assertSceneContent(`${filledScene}\nOne distant figure in series costume, small in frame, not a portrait.`)).toThrow();
  expect(() => assertSceneContent(filledScene.replace("People: none", "People: none except one cultivator"))).toThrow();
  const prompt = assetVisualPrompt({ id: "donghua3d", prompt: donghuaStylePrompt }, {
    kind: "scene", promptFormat: "scene-content-v1", prompt: filledScene, identity: "", state: "",
  });
  expect(prompt).toContain(emptySceneRule);
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
  expect(p).toContain("不写画风");
});

test("CONTENT 禁止再写画风句", () => {
  expect(() =>
    assetVisualPrompt(
      { id: "donghua3d", prompt: donghuaStylePrompt },
      {
        kind: "character",
        promptFormat: "character-content-v1",
        prompt: filledContent
          .replace("Subject: none", "Subject: youth")
          .replace("Face: none", "Face: cinematic donghua 国漫脸"),
        identity: "",
        state: "",
      },
    ),
  ).toThrow(/画风|CONTENT/);
  expect(() =>
    assetVisualPrompt(
      { id: "donghua3d", prompt: donghuaStylePrompt },
      {
        kind: "prop",
        promptFormat: "prop-content-v1",
        prompt: filledProp.replace("Item: none", "Item: cinematic donghua sword"),
        identity: "",
        state: "",
      },
    ),
  ).toThrow(/画风|CONTENT/);
  expect(() =>
    assetVisualPrompt(
      { id: "donghua3d", prompt: donghuaStylePrompt },
      {
        kind: "scene",
        promptFormat: "scene-content-v1",
        prompt: filledScene.replace(
          "Place: none",
          "Place: cinematic donghua mountain photo",
        ),
        identity: "",
        state: "",
      },
    ),
  ).toThrow(/画风|CONTENT/);
});

test("窥伺影只改人设，仍走同一套锁和片场", () => {
  const content = filledContent
    .replace(
      "Subject: none",
      "Subject: non-human grey-gold skinned watcher spirit",
    )
    .replace(
      "Face: none",
      "Face: grey-gold skin, empty eye sockets, no pupils, still in-character",
    )
    .replace(
      "- Outer robe: none",
      "- Outer robe: scorched-gold bone-lacquer robe",
    );
  const prompt = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    {
      name: "窥伺影",
      kind: "character",
      promptFormat: "character-content-v1",
      prompt: content,
      identity: "空脸窥伺影",
      state: "基础定妆",
    },
  );
  expect(prompt).toBe(
    `${sharedStyleDna}\n\n${characterSheetModule}\n\n${characterIdentityRule}\n${content}`,
  );
  expect(prompt).toContain("grey-gold");
  expect(prompt).toContain("empty eye sockets");
  expect(prompt).toContain("scorched-gold bone-lacquer");
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

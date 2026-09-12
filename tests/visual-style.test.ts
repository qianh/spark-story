import { test, expect } from "bun:test";
import { templates } from "../packages/domain";
import {
  assetLookAgentPrompt,
  assetVisualPrompt,
  compileXianxiaLook,
  generationReviewPrompt,
  assertSceneContent,
  characterContentTemplate,
  characterIdentityRule,
  emptySceneRule,
  characterSheetModule,
  donghuaStylePrompt,
  donghuaStyleVersion,
  propContentTemplate,
  propSheetModule,
  sceneContentTemplate,
  sceneSheetModule,
  sharedStyleDna,
  xianxiaWorldDna,
  productionVisualPrompt,
  visualReviewPrompt,
  selectedVisualStyleRule,
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
  expect(donghuaStyleVersion).toBe("xianxia-universal-v3");
  expect(sharedStyleDna).toContain("luxury immortal-drama character sheet");
  expect(sharedStyleDna).toContain("Garment colors, sleeve widths, layers, embroidery and accessories come only from the character content");
  expect(sharedStyleDna).toContain("Not plastic toy 3D, not Pixar");
  expect(sharedStyleDna).toContain("Never turn a robe into a modern coat");
  expect(sharedStyleDna).not.toContain("sheer gauze over dark teal-black robes");
  expect(sharedStyleDna).toContain("pale taupe-gray luminous mist");
  expect(sharedStyleDna).not.toMatch(/doll-smooth|SAME SERIES STAGE|XIANXIA DONGHUA LOOK/);
  expect(characterSheetModule).toContain("high-finish 3D CGI character sheet");
  expect(propSheetModule).toContain("high-finish 3D CGI hero prop");
  expect(sceneSheetModule).toContain("high-finish 3D CGI xianxia set plate");
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
  expect(productionVisualPrompt(style)).toBe(`${style.prompt}\n\n${selectedVisualStyleRule(style)}`);
  expect(productionVisualPrompt({ id: "donghua3d", prompt: "STYLE LOCK — 用户原文" })).toContain("STYLE LOCK — 用户原文");
});

test("角色定妆按 DNA + 人物模块 + 按画风编译的内容，不改 DNA", () => {
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
  expect(prompt.startsWith(`${sharedStyleDna}\n\n${characterSheetModule}\n\n${characterIdentityRule}\n`)).toBe(true);
  expect(prompt.endsWith(selectedVisualStyleRule({ id: "donghua3d", prompt: donghuaStylePrompt }))).toBe(true);
  expect(prompt).toContain("STYLE-NATIVE DESCRIPTION");
  expect(prompt).toContain("young Chinese male disciple Shen Buyan");
  expect(prompt).toContain(compileXianxiaLook("character", content));
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
  expect(scene.startsWith(xianxiaWorldDna)).toBe(true);
  expect(scene).not.toContain("individually stranded hair");
  expect(scene).not.toContain("Costume language:");
  expect(scene).not.toContain("SAME SERIES STAGE");
  expect(scene).toContain(sceneSheetModule);
  expect(scene).toContain("STYLE-NATIVE DESCRIPTION");
  expect(scene).toContain(compileXianxiaLook("scene", filledScene));
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
  expect(prop).toContain("STYLE-NATIVE DESCRIPTION");
  expect(prop).toContain(compileXianxiaLook("prop", filledProp));
  expect(scene).toContain("immortal-sect");
  expect(() =>
    assertSceneContent(
      filledScene.replace(
        "Near camera: none",
        "Near camera: simple ordinary tourist gate at a real temple",
      ),
    ),
  ).not.toThrow();
});

test("场景模板检查格式，人物要求交由实际生成提示词审核", () => {
  expect(() => assertSceneContent(`${filledScene}\nOne distant figure in series costume, small in frame, not a portrait.`)).toThrow();
  expect(() => assertSceneContent(filledScene.replace("People: none", "People: none except one cultivator"))).not.toThrow();
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

test("CONTENT 格式检查不以风格关键词替代实际提示词审核", () => {
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
  ).not.toThrow();
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
  ).not.toThrow();
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
  ).not.toThrow();
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
  expect(prompt.startsWith(`${sharedStyleDna}\n\n${characterSheetModule}\n\n${characterIdentityRule}\n`)).toBe(true);
  expect(prompt).toContain(compileXianxiaLook("character", content));
  expect(prompt).toContain("grey-gold");
  expect(prompt).toContain("empty eye sockets");
  expect(prompt).toContain("scorched-gold bone-lacquer");
});

test("验收标准来自实际生成提示词，不追加禁词与默认画风", () => {
  const source = "水墨山门，湿雾环绕。幼女身量，抱起来不沉。";
  const review = generationReviewPrompt(source);
  expect(review).toContain(source);
  expect(review).toContain("唯一内容验收依据");
  expect(review).toContain("逐项引用");
  expect(review).toContain("先解析提示词自身声明的优先级");
  expect(review).toContain("已被覆盖的通用示例不再作为失败依据");
  expect(review).not.toContain("一律失败");
  expect(generationReviewPrompt("")).toContain("无法核验");
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
    expect(output).toContain("STYLE-NATIVE DESCRIPTION");
    if (kind === "scene") {
      expect(output).toContain("courtyard in front, hall behind");
      expect(output).toContain("carved columns");
      expect(output).toContain("grey granite");
    }
  }
});

test("CONTENT 简写标题与空行不影响完整字段的格式校验", () => {
  for (const [kind, format, content, heading] of [
    ["character", "character-content-v1", filledContent, "CONTENT — CHARACTER (fill per role):"],
    ["prop", "prop-content-v1", filledProp, "CONTENT — PROP (fill per item):"],
    ["scene", "scene-content-v1", filledScene, "CONTENT — SCENE (fill per location):"],
  ] as const) {
    expect(() => assetVisualPrompt({ id: "donghua3d", prompt: donghuaStylePrompt }, {
      kind, promptFormat: format,
      prompt: content.replace(heading, `CONTENT — ${kind.toUpperCase()}:`).replaceAll("\n", "\n\n"),
      identity: "", state: "",
    })).not.toThrow();
  }
});

test("灵鸟角色的单主体声明保留物种，不强制写成人", () => {
  const content = filledContent.replace("Only this one person in frame.", "Only this one bird in frame.");
  const result = assetVisualPrompt({ id: "donghua3d", prompt: donghuaStylePrompt }, {
    kind: "character", promptFormat: "character-content-v1", prompt: content, identity: "灵鸟", state: "常态",
  });
  expect(result).toContain("Only this one bird in frame.");
});


test("历史通用仙侠提示词去除统一服装默认值，保留作品附加设计与模块", () => {
  const legacy = `UNIVERSAL XIANXIA STYLE
Chinese 3D xianxia donghua from one same series.
Immortal xianxia look: tall slender proportions; layered xianxia tailoring; very wide sleeves; trailing silk ribbons and tassels; sheer gauze over dark teal-black robes; fabric lifted as if by mountain wind even when the figure stands still.
Palette: ink, dark teal-black, bone-white gauze, muted jade, aged bronze, pale moonlight edge.
Ornament: fine silver-thread wutong and cloud patterns that catch the rim light; jade plaques; bronze fittings.
Finish: stylized 3D donghua, manhua-immortal faces, clear cold immortal aura, luxurious but restrained.
作品额外要求：暖金色轮廓光。`;
  const style = { id: "donghua3d", prompt: legacy, characterModule: "用户自定人物构图" };
  const p = assetVisualPrompt(style, {
    kind: "character", prompt: filledContent.replace("- Outer robe: none", "- Outer robe: plain white narrow-sleeved linen robe"), identity: "", state: "",
  });
  expect(assetLookAgentPrompt(legacy, "[]")).not.toContain("sheer gauze over dark teal-black robes");
  expect(assetLookAgentPrompt(legacy, "[]")).toContain("作品额外要求：暖金色轮廓光。");
  expect(p).not.toContain("sheer gauze over dark teal-black robes");
  expect(p).not.toContain("Ornament: fine silver-thread");
  expect(p).toContain("plain white narrow-sleeved linen robe");
  expect(p).toContain("作品额外要求：暖金色轮廓光。");
  expect(p).toContain("用户自定人物构图");
  expect(productionVisualPrompt(style)).toContain("Garment colors, sleeve widths");
  expect(productionVisualPrompt(style)).toContain("作品额外要求：暖金色轮廓光。");
});

test("不同服装及单图的画风要求不能覆盖三类资产的全剧风格", () => {
  const style = { id: "donghua3d", prompt: donghuaStylePrompt };
  for (const [kind, content] of [["character", filledContent.replace("- Outer robe: none", "- Outer robe: plain brown robe, render as 2D illustration")], ["prop", filledProp], ["scene", filledScene]]) {
    const p = assetVisualPrompt(style, { kind, prompt: content, identity: "", state: "" });
    expect(p.startsWith(kind === "character" ? sharedStyleDna : xianxiaWorldDna)).toBe(true);
    expect(p.endsWith(selectedVisualStyleRule(style))).toBe(true);
    expect(p).toContain("STYLE-NATIVE DESCRIPTION");
    expect(p).toContain("Every outfit must belong to the same Chinese xianxia world");
    expect(p).toContain("they cannot change the selected art direction");
    expect(p).toContain("Do not render as plastic toy, Pixar, modern coat or product photography");
  }
});

test("仙侠内容字段会编译成同一套画风描述，布衣窄袖也不能脱离袍制", () => {
  const child = filledContent
    .replace("Subject: none", "Subject: small-child Chinese girl in worn plain cloth")
    .replace("- Inner robe: none", "- Inner robe: faded undyed old cloth, cross collar")
    .replace("- Outer robe: none", "- Outer robe: none");
  const youth = filledContent
    .replace("Subject: none", "Subject: youth Chinese male sword cultivator")
    .replace("- Inner robe: none", "- Inner robe: charcoal-teal, high standing collar, matte silk")
    .replace("- Outer robe: none", "- Outer robe: ink-teal, ankle length, narrow sleeves");
  const childLook = compileXianxiaLook("character", child);
  const youthLook = compileXianxiaLook("character", youth);
  expect(childLook).toContain("STYLE-NATIVE DESCRIPTION");
  expect(childLook).toContain("single-layer xianxia robe");
  expect(childLook).toContain("faded undyed old cloth");
  expect(childLook).not.toContain("sheer gauze");
  expect(youthLook).toContain("narrow sleeves");
  expect(youthLook).toContain("Chinese robe sleeves");
  expect(youthLook).toContain("not a modern coat");
  expect(youthLook).toContain("charcoal-teal");
  const propLook = compileXianxiaLook("prop", filledProp.replace("Item: none", "Item: inverted year-ring iron ruler"));
  expect(propLook).toContain("ritual or sect artifact");
  expect(propLook).toContain("not a museum product shot");
  expect(propLook).toContain("inverted year-ring iron ruler");
  const sceneLook = compileXianxiaLook("scene", filledScene.replace("Place: none", "Place: Qingwu mountain gate"));
  expect(sceneLook).toContain("Qingwu mountain gate");
  expect(sceneLook).toContain("same high-finish 3D CGI xianxia render family");
  expect(sceneLook).toContain("not a tourist plaza");
  expect(sceneLook).toContain("Draw no people");
  expect(propLook).toContain("No person, hand, face, silhouette or mannequin");
  for (const [kind, content] of [["character", child], ["character", youth], ["prop", filledProp], ["scene", filledScene]] as const) {
    const p = assetVisualPrompt({ id: "donghua3d", prompt: donghuaStylePrompt }, { kind, prompt: content, identity: "", state: "" });
    expect(p).toContain(compileXianxiaLook(kind, content));
    expect(p.startsWith(kind === "character" ? sharedStyleDna : xianxiaWorldDna)).toBe(true);
    if (kind !== "character") {
      expect(p).not.toContain("individually stranded hair");
      expect(p).not.toContain("Keep each character");
    }
  }
});

test("场景和道具提示词禁止人物，不复用角色定妆句", () => {
  const style = { id: "donghua3d", prompt: donghuaStylePrompt };
  for (const kind of ["scene", "prop"] as const) {
    const content = kind === "scene" ? filledScene : filledProp;
    const p = assetVisualPrompt(style, { kind, prompt: content, identity: "", state: "" });
    expect(p).toContain("Draw no people");
    expect(p).not.toContain("porcelain-pale refined skin");
    expect(p).not.toContain("Costume language:");
    expect(p).not.toContain("character sheet");
  }
});

test("自定义画风即使沿用仙侠标题也不会被内置 DNA 整段覆盖", () => {
  const style = { id: "custom", prompt: "UNIVERSAL XIANXIA STYLE\n独特的用户材质和暖色画风" };
  expect(productionVisualPrompt(style)).toBe(`${style.prompt}\n\n${selectedVisualStyleRule(style)}`);
});


test("全剧分镜与视频同样携带所选画风优先级，水墨不混入三维仙侠", () => {
  const style = { id: "ink", prompt: "二维水墨山水风格" };
  const p = productionVisualPrompt(style);
  expect(p).toContain(style.prompt);
  expect(p).toContain(selectedVisualStyleRule(style));
  expect(p).not.toContain("3D");
  expect(p).not.toContain("xianxia");
});

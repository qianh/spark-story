import { test, expect } from "bun:test";
import { templates } from "../packages/domain";
import {
  affirmativeLookText,
  assetContentDrifted,
  assetLookAgentPrompt,
  assetVisualPrompt,
  compileXianxiaLook,
  generationReviewPrompt,
  lookBriefIssues,
  lookContentIssues,
  repairLookIsolation,
  repairLookPrompt,
  creatureSheetModule,
  sameLookStyleFamily,
  assertSceneContent,
  assertCharacterContent,
  assertPropContent,
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
  lookSheetAspect,
  lookSheetResolution,
  lookSheetOptions,
  characterLookAngleLine,
  normalizedXianxiaDna,
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

test("通用仙侠画风写的是参考图的感觉，身份留给各资产内容", () => {
  const t = templates.find((x) => x.id === "donghua3d")!;
  expect(t.prompt).toBe(sharedStyleDna);
  expect(donghuaStylePrompt.startsWith("UNIVERSAL XIANXIA STYLE\n")).toBe(true);
  expect(donghuaStyleVersion).toBe("xianxia-universal-v4");
  // 感觉：半写实 3D CG 仙侠海报质感、冷灰银青调、云雾山峦、柔和天光、国漫仙人脸、风动发衣
  expect(sharedStyleDna).toContain("Semi-realistic 3D CG Chinese xianxia key art");
  expect(sharedStyleDna).toContain("cold, ethereal, immortal");
  expect(sharedStyleDna).toContain("grey-silver-blue");
  expect(sharedStyleDna).toContain("mist-wrapped jagged peaks");
  expect(sharedStyleDna).toContain("soft overcast daylight");
  expect(sharedStyleDna).toContain("manhua-immortal features");
  expect(sharedStyleDna).toContain("lifted by mountain wind");
  expect(sharedStyleDna).toContain("never plastic toy 3D, never Pixar");
  // 身份差异归内容：不同角色不能一张脸，素衣仍是这一族
  expect(sharedStyleDna).toContain("different characters must not share one face");
  expect(sharedStyleDna).toContain("plain cloth stays plain, and plain cloth still reads as this same xianxia world");
  // 不再写棚拍、不再把画风元素写成禁令
  expect(sharedStyleDna).not.toMatch(/taupe-gray|studio key from front-left|Do not add gauze|luxury immortal-drama/);
  expect(sharedStyleDna).not.toMatch(/doll-smooth|SAME SERIES STAGE|XIANXIA DONGHUA LOOK/);
  expect(xianxiaWorldDna).toContain("Occupancy: empty of figures");
  expect(xianxiaWorldDna).not.toMatch(/Faces:|Costume feel:|Hair and fabric:/);
  expect(characterSheetModule).toContain("series character sheet");
  expect(characterSheetModule).toContain("softly blurred mist and distant peaks");
  expect(characterSheetModule).not.toContain("taupe-gray");
  expect(propSheetModule).toContain("One reusable object");
  expect(propSheetModule).not.toContain("ritual");
  expect(propSheetModule).not.toContain("taupe-gray");
  expect(sceneSheetModule).toContain("series set plate");
  expect(sceneSheetModule).toContain("cloud-wrapped peaks");
});

const filledContent = characterContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledProp = propContentTemplate.replace(/\[[^\]]+\]/g, "none");
const filledScene = sceneContentTemplate.replace(/\[[^\]]+\]/g, "none");

test("作品锁定的通用仙侠原文生图时不被目录稿替换", () => {
  const locked = `UNIVERSAL XIANXIA STYLE
Chinese 3D xianxia donghua from one same series.
Immortal xianxia look: tall slender proportions; layered xianxia tailoring; very wide sleeves; trailing silk ribbons and tassels; sheer gauze over dark teal-black robes; fabric lifted as if by mountain wind even when the figure stands still.
Palette: ink, dark teal-black, bone-white gauze, muted jade, aged bronze, pale moonlight edge.
Light: soft donghua key plus cool moonlight rim on hair, sleeve edges, carved wood and jade.
Ornament: fine silver-thread wutong and cloud patterns that catch the rim light; jade plaques; bronze fittings.
Finish: stylized 3D donghua, manhua-immortal faces, clear cold immortal aura, luxurious but restrained.
Air: faint luminous mist, never a dead brown studio void.
Same visual family for characters, props, and sets.`;
  const style = {
    id: "donghua3d",
    version: "xianxia-universal-v1",
    prompt: locked,
    characterModule: "ASSET: character sheet. Full-body standing, three-quarter, feet visible, pale mist studio. One person.",
    propModule: "ASSET: hero prop.",
    sceneModule: "ASSET: set plate.",
  };
  const result = assetVisualPrompt(style, {
    kind: "character",
    prompt: filledContent,
    identity: "",
    state: "",
  });
  expect(result.startsWith(locked)).toBe(true);
  expect(result).toContain("Chinese 3D xianxia donghua from one same series.");
  expect(result).toContain("manhua-immortal faces");
  expect(result).toContain("soft donghua key");
  expect(result).not.toContain("porcelain-pale refined skin");
  expect(result).not.toContain("luxury immortal-drama character sheet");
});

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
  expect(prompt).toContain("SERIES LOOK BRIEF");
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
  expect(scene).toContain("SERIES LOOK BRIEF");
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
  expect(prop).toContain("SERIES LOOK BRIEF");
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
  expect(() => assertSceneContent(filledScene.replace("People: none", "People: none except one cultivator"))).not.toThrow();
  const prompt = assetVisualPrompt({ id: "donghua3d", prompt: donghuaStylePrompt }, {
    kind: "scene", promptFormat: "scene-content-v1", prompt: filledScene, identity: "", state: "",
  });
  expect(prompt).toContain(emptySceneRule);
});

test("模型稿可以没有 CONTENT 标题，字段齐了就能编译", () => {
  const character = filledContent.replace("CONTENT — CHARACTER (fill per role):\n", "");
  const prop = filledProp
    .replace("CONTENT — PROP (fill per item):\n", "")
    .replace("Item: none", "Item: one teal qing-feather");
  const scene = filledScene.replace("CONTENT — SCENE (fill per location):\n", "");
  expect(() => assertCharacterContent(character)).not.toThrow();
  expect(() => assertPropContent(prop)).not.toThrow();
  expect(() => assertSceneContent(scene)).not.toThrow();
  expect(compileXianxiaLook("character", character)).toContain("SERIES LOOK BRIEF");
  expect(compileXianxiaLook("prop", prop)).toContain("one teal qing-feather");
  expect(compileXianxiaLook("scene", scene)).toContain("series-wide empty set plate");
  const p = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    { kind: "prop", promptFormat: "prop-content-v1", prompt: prop, identity: "", state: "" },
  );
  expect(p).toContain("SERIES LOOK BRIEF");
  expect(lookBriefIssues("prop", p)).toEqual([]);
});

test("模型多写的 HARD IMAGE LOCK 折进上一字段，不挡格式", () => {
  const scene = filledScene.replace(
    "Place: none",
    "Place: 青梧宗年轮大殿室内封闭殿室\nHARD IMAGE LOCK: indoor box, not a yard. No courtyard pavement.",
  );
  expect(() => assertSceneContent(scene)).not.toThrow();
  expect(compileXianxiaLook("scene", scene)).toContain("室内封闭殿室");
});

test("缺必填字段仍然拒绝", () => {
  expect(() => assertPropContent("Item: a box\nForm: closed")).toThrow(/道具内容需按模板逐项填写/);
});

test("模型漏写 none 栏、多写其他类型字段时，道具仍能编译", () => {
  const furnace = `Item: inverted Wanxiang furnace
Size impression: one standing furnace
Materials: scorched gold
Form: mouth downward
Condition: intact
Unique marks: broken-mirror ding
View: full item, slight three-quarter
Time / weather: default readable daylight`;
  expect(() => assertPropContent(furnace)).not.toThrow();
  expect(compileXianxiaLook("prop", furnace)).toContain("inverted Wanxiang furnace");
  expect(compileXianxiaLook("prop", furnace)).toContain("mouth opening faces the ground");
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
  expect(p).toContain("飞檐、斗拱、宫墙只在内容明确要求时写");
  expect(p).not.toContain("sect artifact");
  expect(p).not.toContain("photorealistic landscape");
  expect(p).not.toContain("museum antique");
  expect(p).toContain("不写画风");
  expect(p).toContain("Enclosure");
  expect(p).toContain("Scale");
  expect(p).toContain("每一条定妆只写该资产自己");
  expect(p).toContain("章节只作参考");
  expect(p).toContain("不写某一集的布置");
  expect(p).toContain("只许把本条外观登记翻译进 CONTENT");
  expect(p).toContain("青鸟、灵兽全部 Costume 写 none");
  expect(p).toContain("Camera 必须跟 Enclosure 同类");
  expect(p).toContain("父兄式身量只写宽肩厚背的青年体量");
  expect(p).toContain("登记要腰侧归鞘且没有独立剑资产时");
  expect(p).toContain("三张同尺寸全身");
  expect(p).not.toContain("场景/建筑改用 monumental、mythic scale、ceremonial、designed、flying eaves、dougong、constructed set");
});

test("场景模块和开敞高台都不强加飞檐殿宇", () => {
  expect(sceneSheetModule).not.toContain("flying eaves");
  expect(sceneContentTemplate).toContain("Enclosure:");
  expect(sceneContentTemplate).toContain("Scale:");
  const terrace = sceneContentTemplate
    .replace("[tongtian ancient wutong / sect mountain gate / indoor axial hall / open white-stone platform / enclosed medicine room / grain cliff / empty stone yard]", "alliance cloud-ridge asking-the-way high platform")
    .replace("[standing tree in cloud / indoor enclosed hall / outdoor open terrace / mountain gate / grain cliff / empty stone yard]", "outdoor open terrace, no palace wings")
    .replace("[whole tree, crown and roots lost in cloud / platform taller than a person / hall deep enough for facing seats / human-scale path]", "platform taller than a standing adult, watchers look up from the terrace below")
    .replace(/\[[^\]]+\]/g, "none");
  const prompt = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    {
      kind: "scene",
      promptFormat: "scene-content-v1",
      prompt: terrace,
      identity: "盟会问道台",
      state: "大型白石高台",
    },
  );
  expect(prompt).not.toContain("grey tile, flying eaves");
  expect(prompt).not.toMatch(/Near camera:.*dougong/);
  expect(prompt).toContain("outdoor open terrace");
  expect(prompt).toContain("Do not add flying eaves");
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
    expect(output).toContain("SERIES LOOK BRIEF");
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


test("历史锁定的通用仙侠原文保留附加设计与模块，不被目录稿改写", () => {
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
  expect(assetLookAgentPrompt(legacy, "[]")).toContain("sheer gauze over dark teal-black robes");
  expect(assetLookAgentPrompt(legacy, "[]")).toContain("作品额外要求：暖金色轮廓光。");
  expect(p).toContain("sheer gauze over dark teal-black robes");
  expect(p).toContain("Ornament: fine silver-thread");
  expect(p).toContain("plain white narrow-sleeved linen robe");
  expect(p).toContain("作品额外要求：暖金色轮廓光。");
  expect(p).toContain("用户自定人物构图");
  expect(p).not.toContain("porcelain-pale refined skin");
  expect(productionVisualPrompt(style)).toContain("sheer gauze over dark teal-black robes");
  expect(productionVisualPrompt(style)).toContain("作品额外要求：暖金色轮廓光。");
});

test("不同服装及单图的画风要求不能覆盖三类资产的全剧风格", () => {
  const style = { id: "donghua3d", prompt: donghuaStylePrompt };
  for (const [kind, content] of [["character", filledContent.replace("- Outer robe: none", "- Outer robe: plain brown robe, render as 2D illustration")], ["prop", filledProp], ["scene", filledScene]]) {
    const p = assetVisualPrompt(style, { kind, prompt: content, identity: "", state: "" });
    expect(p.startsWith(kind === "character" ? sharedStyleDna : xianxiaWorldDna)).toBe(true);
    expect(p.endsWith(selectedVisualStyleRule(style))).toBe(true);
    expect(p).toContain("SERIES LOOK BRIEF");
    expect(p).toContain("Every outfit must belong to the same Chinese xianxia world");
    expect(p).toContain("they cannot change the selected art direction");
    expect(p).toContain("Do not render as plastic toy, Pixar, flat anime cel, modern coat or product photography");
    expect(p.slice(p.indexOf("SERIES LOOK BRIEF"))).not.toMatch(/render as 2D illustration/i);
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
  expect(childLook).toContain("SERIES LOOK BRIEF");
  expect(childLook).toContain("Outer robe: none specified; the inner robe is the full-length robe");
  expect(childLook).toContain("faded undyed old cloth");
  expect(childLook).toContain("traditional Chinese xianxia robe construction");
  expect(childLook).toContain("plain cloth still reads as this xianxia world");
  expect(childLook).not.toMatch(/Do not add|Keep a single-layer/);
  expect(youthLook).toContain("narrow sleeves");
  expect(youthLook).toContain("charcoal-teal");
  expect(youthLook).toContain("Style feel: same series as every other sheet");
  const propLook = compileXianxiaLook("prop", filledProp.replace("Item: none", "Item: inverted year-ring iron ruler"));
  expect(propLook).toContain("inverted year-ring iron ruler");
  expect(propLook).not.toContain("ritual or sect artifact");
  expect(propLook).not.toContain("ding stands upside down");
  const sceneLook = compileXianxiaLook("scene", filledScene.replace("Place: none", "Place: Qingwu mountain gate"));
  expect(sceneLook).toContain("Qingwu mountain gate");
  expect(sceneLook).toContain("series-wide empty set plate");
  expect(sceneLook).toContain("Style feel: same series as every other plate");
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


test("场景模板不把亭、院子、不可读匾写成默认答案", () => {
  expect(sceneContentTemplate).not.toContain("cliff pavilion");
  expect(sceneContentTemplate).not.toContain("bamboo courtyard");
  expect(sceneContentTemplate).not.toContain("unreadable plaque");
  expect(sceneContentTemplate).toContain("enclosed medicine room");
  expect(sceneContentTemplate).toContain("open white-stone platform");
  expect(propContentTemplate).toContain("inverted ding, mouth downward");
  expect(propContentTemplate).toContain("year-ring iron scale");
  expect(propContentTemplate).not.toContain("not a school ruler");
  expect(characterContentTemplate).toContain("empty-eye wells, two open holes");
  expect(characterContentTemplate).not.toContain("masquerade");
});

test("定妆 Agent 只写正面形制，不把禁物名词写进 CONTENT", () => {
  const p = assetLookAgentPrompt(donghuaStylePrompt, "[]", "[]");
  expect(p).not.toContain("readable sign");
  expect(p).not.toContain("carnival mask");
  expect(p).not.toContain("school ruler");
  expect(p).not.toContain("ritual、sect artifact");
  expect(p).toContain("只写正面形制");
  expect(p).toContain("宗门山门牌匾写该宗之名");
  expect(p).toContain("空眼写贴面空板");
  expect(p).toContain("倒置炉鼎口朝下");
});

test("编译只认正面形制：无铁尺不锁尺，地名含青梧宗不锁匾，不是室内不锁正殿", () => {
  const tree = compileXianxiaLook(
    "scene",
    filledScene
      .replace("Place: none", "Place: 通天古梧")
      .replace("Enclosure: none", "Enclosure: outdoor open tree in cloud sea")
      .replace(
        "Set dressing: none",
        "Set dressing: year-rings, gold leaves. 无空眼面具、无铁尺、无倒置年轮槽",
      ),
  );
  expect(tree).not.toContain("Empty-eye lock");
  expect(tree).not.toContain("iron year-ring measuring bar");
  expect(tree).not.toContain("Orientation lock");
  expect(tree).toContain("this set has no writing");
  const cliff = compileXianxiaLook(
    "scene",
    filledScene
      .replace("Place: none", "Place: 青梧宗剑崖")
      .replace("Enclosure: none", "Enclosure: 室外开敞（露天崖）")
      .replace("Set dressing: none", "Set dressing: none")
      .replace("Camera: none", "Camera: 露天崖体，不是台、不是甲板"),
  );
  expect(cliff).not.toContain("exact sect-name characters");
  expect(cliff).toContain("this set has no writing");
  expect(cliff).not.toContain("keep this an open terrace");
  const gate = compileXianxiaLook(
    "scene",
    filledScene
      .replace(
        "Place: none",
        "Place: 青梧宗山门, not an indoor main hall, not a courtyard",
      )
      .replace("Enclosure: none", "Enclosure: outdoor open mountain gate"),
  );
  expect(gate).not.toContain("roofed indoor hall");
  expect(gate).not.toContain("keep this an open terrace");
});

test("编译空眼、倒置炉和倒年轮尺只写正面形制", () => {
  const mask = compileXianxiaLook(
    "character",
    filledContent.replace(
      "Face: none",
      "Face: empty-eye mask flush to the face, two empty wells, no pupils, not a masquerade mask",
    ),
    "three-quarter",
    { name: "空眼殿主", form: "空眼面具贴面" },
  );
  expect(mask).toContain("blank plate flush to the face");
  expect(mask).toContain("two punched open wells");
  expect(mask).not.toMatch(/carnival|Venetian|Noh|masquerade|\bmask\b|in-character look/i);
  const furnace = compileXianxiaLook(
    "prop",
    filledProp
      .replace("Item: none", "Item: inverted ding-furnace")
      .replace("Form: none", "Form: mouth downward"),
  );
  expect(furnace).toContain("mouth opening faces the ground");
  expect(furnace).not.toContain("goblet");
  expect(furnace).not.toContain("chalice");
  const ruler = compileXianxiaLook(
    "prop",
    filledProp.replace("Item: none", "Item: inverted year-ring iron ruler"),
  );
  expect(ruler).toContain("dark iron bar");
  expect(ruler).toContain("inverted year-rings");
  expect(ruler).not.toContain("ding stands upside down");
  expect(ruler).not.toMatch(/school ruler|decorative vine/i);
  const hall = compileXianxiaLook(
    "scene",
    filledScene
      .replace("Place: none", "Place: indoor axial main hall")
      .replace("Enclosure: none", "Enclosure: indoor enclosed hall"),
  );
  expect(hall).toContain("roofed indoor hall with beams");
  expect(hall).not.toContain("open courtyard");
  const gate = compileXianxiaLook(
    "scene",
    filledScene.replace(
      "Set dressing: none",
      "Set dressing: lintel plaque 门楣匾额写「青梧宗」三字",
    ),
  );
  expect(gate).toContain("exact sect-name characters");
  expect(gate).not.toMatch(/weathered blank lintel/);
});

test("旧道具模块把羽写成法器时，出图前会拦住", () => {
  expect(
    lookBriefIssues(
      "prop",
      `ASSET: high-finish 3D CGI hero prop. One ritual or sect object.\nSERIES LOOK BRIEF\nItem: one teal qing-feather.`,
    ),
  ).toEqual(expect.arrayContaining(["羽被写成法器"]));
});

test("编译不把引号当匾，不把羽升格成法器", () => {
  const yard = compileXianxiaLook(
    "scene",
    filledScene
      .replace(
        "Place: none",
        "Place: 青梧宗外门青石坪, a stone yard of its own",
      )
      .replace(
        "Set dressing: none",
        "Set dressing: empty space that can park 木车青布「商队」; salt traces",
      ),
  );
  expect(yard).not.toContain('plaque reads "商队"');
  expect(yard).not.toContain("On-image text");
  const gate = compileXianxiaLook(
    "scene",
    filledScene.replace(
      "Set dressing: none",
      "Set dressing: 门楣牌匾只写「青梧宗」三字",
    ),
  );
  expect(gate).toContain('the lintel plaque reads "青梧宗"');
  const feather = compileXianxiaLook(
    "prop",
    filledProp
      .replace("Item: none", "Item: one teal qing-feather")
      .replace("Form: none", "Form: single plume"),
  );
  expect(feather).toContain("one teal qing-feather");
  expect(feather).not.toContain("ritual or sect artifact");
  expect(feather).not.toContain("ritual or sect object");
  expect(lookBriefIssues("prop", feather)).toEqual([]);
  expect(lookBriefIssues("scene", yard)).toEqual([]);
  const oldModule = assetVisualPrompt(
    {
      id: "donghua3d",
      prompt: donghuaStylePrompt,
      propModule:
        "ASSET: high-finish 3D CGI hero prop. One ritual or sect object, three-quarter.",
      characterModule: "ASSET: character",
      sceneModule: "ASSET: scene",
    },
    {
      kind: "prop",
      promptFormat: "prop-content-v1",
      prompt: filledProp
        .replace("Item: none", "Item: one teal qing-feather")
        .replace("Form: none", "Form: single plume"),
      identity: "",
      state: "",
    },
  );
  expect(oldModule).toContain("One reusable object");
  expect(oldModule).not.toContain("ritual or sect object");
  expect(lookBriefIssues("prop", oldModule)).toEqual([]);
});

test("通天古梧写成树皮特写要打回", () => {
  expect(
    lookContentIssues(
      "scene",
      "Place: 通天古梧\nScale: near view shows only one stretch of wutong-grain bark\nNear camera: one stretch of huge trunk bark",
      {
        name: "通天古梧",
        identity: "冠看不见顶，根看不见底",
        form: "通天巨梧，根冠入云海",
      },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("特写")]));
});

test("通天古梧定妆不能写进山门，山门不能写进整棵树", () => {
  expect(
    lookContentIssues(
      "scene",
      "Place: 青梧宗山门通天古梧\nNear camera: 梧桐木纹门柱\nSet dressing: 门楣牌匾写青梧宗、山门石阶",
      {
        name: "通天古梧",
        identity: "青梧宗山门通天古梧。冠看不见顶，根看不见底。",
        otherLooks: [
          {
            name: "梧桐木纹山门",
            kind: "scene",
            identity: "青梧宗山门。门楣匾额为青梧宗。",
            form: "梧桐木纹门柱，山门石阶。",
          },
        ],
      },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("山门")]));
  expect(
    lookContentIssues(
      "scene",
      "Place: 通天古梧\nNear camera: 根皮梧桐木纹\nFar: 冠入云海看不见顶\nSet dressing: 树体年轮纹、金叶",
      {
        name: "通天古梧",
        identity: "青梧宗山门通天古梧。冠看不见顶，根看不见底。",
        form: "通天巨梧，叶脉可渗潮气。根冠入云海。金叶。",
        otherLooks: [
          {
            name: "梧桐木纹山门",
            kind: "scene",
            identity: "青梧宗山门",
            form: "门柱，山门石阶，门楣牌匾",
          },
        ],
      },
    ),
  ).toEqual([]);
  expect(
    lookContentIssues(
      "scene",
      "Place: 青梧宗山门通天古梧\nNear camera: 根皮梧桐木纹\nFar: 冠入云海看不见顶\nSet dressing: 树体年轮纹、金叶\nCamera: 不画山门台",
      {
        name: "通天古梧",
        identity: "青梧宗山门通天古梧。冠看不见顶，根看不见底。",
        otherLooks: [
          {
            name: "梧桐木纹山门",
            kind: "scene",
            identity: "青梧宗山门",
            form: "门柱，山门石阶",
          },
        ],
      },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("山门")]));
  expect(
    lookContentIssues(
      "scene",
      "Place: 青梧宗山门，通天古梧所在\nNear camera: 门柱\nSet dressing: 牌匾青梧宗\nFar: 开敞空处",
      {
        name: "梧桐木纹山门",
        identity: "青梧宗山门。通天古梧所在的山门。",
        form: "门柱，山门石阶，门楣牌匾",
        otherLooks: [
          {
            name: "通天古梧",
            kind: "scene",
            identity: "冠看不见顶，根看不见底",
            form: "通天巨梧，金叶",
          },
        ],
      },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("通天古梧")]));
  expect(
    lookContentIssues(
      "scene",
      "Place: 青梧宗山门\nNear camera: 门柱\nSet dressing: 牌匾青梧宗\nFar: 冠看不见顶，根看不见底，通天巨梧",
      {
        name: "梧桐木纹山门",
        identity: "青梧宗山门。通天古梧所在的山门。",
        form: "门柱，山门石阶，门楣牌匾",
        otherLooks: [
          {
            name: "通天古梧",
            kind: "scene",
            identity: "冠看不见顶，根看不见底",
            form: "通天巨梧，金叶",
          },
        ],
      },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("通天古梧")]));
});

test("隔离修复后古梧与山门互不写入，否定句不误伤", () => {
  const tree = repairLookIsolation(
    "scene",
    "Place: 青梧宗山门通天古梧，木相生机之树\nCamera: 不画山门台、问道台",
    { name: "通天古梧", identity: "青梧宗山门通天古梧" },
  );
  const gate = repairLookIsolation(
    "scene",
    "Place: 青梧宗山门，通天古梧所在\nNear camera: 门柱",
    { name: "梧桐木纹山门", identity: "通天古梧所在的山门" },
  );
  expect(tree).toContain("Place: 通天古梧");
  expect(tree).not.toContain("山门通天古梧");
  expect(gate).toContain("Place: 青梧宗山门");
  expect(gate).not.toContain("通天古梧所在");
  expect(
    lookContentIssues("scene", tree, {
      name: "通天古梧",
      identity: "青梧宗山门通天古梧。冠看不见顶，根看不见底。",
    }),
  ).toEqual([]);
  expect(
    lookContentIssues("scene", gate, {
      name: "梧桐木纹山门",
      identity: "青梧宗山门。通天古梧所在的山门。",
    }),
  ).toEqual([]);
});

test("剑崖问道台只认肯定句，CONTENT 其他画风要打回", () => {
  expect(
    lookContentIssues("scene", "Enclosure: 室外开敞崖\nCamera: 露天崖体，不是亭阁", {
      name: "剑崖",
      identity: "青梧宗剑崖",
    }),
  ).toEqual([]);
  expect(
    lookContentIssues("scene", "Enclosure: 室外开敞崖\nNear camera: cliff pavilion 亭阁", {
      name: "剑崖",
      identity: "青梧宗剑崖",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("亭阁")]));
  expect(
    lookContentIssues("scene", "Enclosure: 室外开敞\nArchitecture: 不要飞檐 dougong", {
      name: "盟会问道台",
      identity: "白石问道高台",
    }),
  ).toEqual([]);
  expect(
    lookContentIssues(
      "character",
      "Face: empty-eye wells, not a masquerade mask, no pupils",
      { name: "空眼殿主", identity: "空眼面具贴面" },
    ),
  ).toEqual([]);
  expect(
    lookContentIssues(
      "character",
      "Face: flush empty-eye mask as a flat plate, two open empty-eye wells",
      { name: "空眼殿主", identity: "空眼面具贴面" },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("面具")]));
  expect(
    repairLookPrompt(
      "character",
      "Face: flush empty-eye mask as a flat plate, two open empty-eye wells",
      { name: "空眼殿主", identity: "空眼面具贴面" },
    ),
  ).not.toMatch(/\bmask\b|面具/);
  expect(
    lookContentIssues(
      "character",
      "Face: flush empty-eye plate, still in-character look on the plate",
      { name: "空眼殿主", identity: "空眼面具贴面" },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("五官表情")]));
  expect(
    lookContentIssues(
      "character",
      "Outer robe: plain brown robe, render as 2D illustration",
      { name: "青梧大师兄", identity: "青梧弟子" },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("画风")]));
});

test("否定句里的院子不判写成院子，肯定句的院子仍要抓", () => {
  expect(
    lookContentIssues(
      "scene",
      "Enclosure: indoor enclosed hall\nPlace: 室内正殿。非庭院。This is not a courtyard. No courtyard pavement.",
      {
        name: "年轮大殿",
        identity: "室内中轴正殿",
        excerpts: "年轮大殿是室内中轴正殿，尽头本根如神位",
      },
    ),
  ).toEqual([]);
  expect(
    lookContentIssues("scene", "Enclosure: outdoor open courtyard\nCamera: medium courtyard", {
      name: "年轮大殿",
      identity: "室内中轴正殿",
      excerpts: "年轮大殿是室内中轴正殿，尽头本根如神位",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("院子")]));
});

test("CONTENT 机械核对能抓住院子、空眼和乱字匾", () => {
  expect(
    lookContentIssues("scene", "Enclosure: outdoor open courtyard\nCamera: medium courtyard", {
      name: "年轮大殿",
      identity: "室内中轴正殿",
      excerpts: "年轮大殿是室内中轴正殿，尽头本根如神位",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("院子")]));
  expect(
    lookContentIssues("scene", "Set dressing: unreadable plaque", {
      name: "梧桐木纹山门",
      identity: "青梧宗山门。门楣匾额为青梧宗。",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("宗名")]));
  expect(
    lookContentIssues("scene", "Set dressing: unreadable plaque", {
      name: "年轮大殿",
      identity: "门楣旧匾字迹被潮气吃尽，不可读",
    }),
  ).toEqual([]);
  expect(
    lookContentIssues("character", "Face: masquerade eye-mask with pupils", {
      name: "空眼殿主",
      identity: "空眼面具贴面",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("空眼")]));
});

test("章节里别人的空眼，不能把苏晚晴判成空眼", () => {
  const child = `CONTENT — CHARACTER (fill per role):

Subject: child Chinese girl xianxia Qingwu foundling, young-girl stature light enough to be carried, thin shoulders, slight build.

Face: pale, soft child brows, very dark shallow eyes, pupils empty of year-ring grain, small lips, round child jaw, still quiet in-character expression, unique marks: a very faint gold-leaf print on the forehead.

Hair: dark, dull, lackluster, child length, worn loose, hairpiece: none.

Costume:
- Inner robe: faded plain coarse cloth, cross-collar
- Outer robe: matching worn plain cloth, child-length
- Overlay: none
- Embroidery: none
- Waist: plain cloth sash
- Other accessories: none
- Shoes: dark rounded-toe cloth boots, worn

Pose: standing upright, hands hanging naturally at sides, weight even.
Only this one person in frame.`;
  expect(
    lookContentIssues("character", child, {
      name: "初相·稚梧（幼女）",
      identity:
        "苏晚晴。幼女身量，抱起来不沉。眼睛很黑很浅，发丝无光泽，瞳中无纹。眉心有极淡金叶印记。",
      form: "素衣旧布，弱光贴在眉心。初相·稚梧的入宗形制。领口可洗至发白。",
      excerpts:
        "空眼殿主戴空眼面具，空孔如两口枯井。苏晚晴站在山门，瞳中无纹。墨坼的空眼里年轮倒转。",
    }),
  ).toEqual([]);
  expect(
    lookContentIssues("character", "Face: masquerade eye-mask with pupils", {
      name: "空眼殿主",
      identity: "空眼面具贴面",
      excerpts: "苏晚晴眼睛很黑很浅，瞳中无纹。",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("空眼")]));
});

test("旧图只在 CONTENT 关键句变了才算漂移", () => {
  const prompt = filledScene.replace("Place: none", "Place: Qingwu medicine room");
  expect(
    assetContentDrifted({
      kind: "scene",
      prompt,
      generationPrompt: `Place: Qingwu medicine room as a set\nSet dressing: none`,
    }),
  ).toBe(false);
  expect(
    assetContentDrifted({
      kind: "scene",
      prompt: prompt.replace("Set dressing: none", "Set dressing: lintel plaque 门楣匾额写「青梧宗」三字"),
      generationPrompt: "Place: Qingwu medicine room\nSet dressing: unreadable plaque",
    }),
  ).toBe(true);
  const style = { id: "donghua3d", prompt: donghuaStylePrompt, version: "xianxia-universal-v3" };
  const family = JSON.stringify([
    "donghua3d",
    "xianxia-universal-v3",
    donghuaStylePrompt,
    donghuaStylePrompt,
    "old character module",
    "old prop module",
    "Monumental flying eaves dougong",
    "",
    0,
  ]);
  expect(sameLookStyleFamily(family, style)).toBe(true);
  expect(sameLookStyleFamily(JSON.stringify(["ink", "ink", "水墨", "水墨", "", "", "", "", 0]), style)).toBe(false);
});

test("全剧分镜与视频同样携带所选画风优先级，水墨不混入三维仙侠", () => {
  const style = { id: "ink", prompt: "二维水墨山水风格" };
  const p = productionVisualPrompt(style);
  expect(p).toContain(style.prompt);
  expect(p).toContain(selectedVisualStyleRule(style));
  expect(p).not.toContain("3D");
  expect(p).not.toContain("xianxia");
});

test("定妆编译是全剧 brief，画风原文仍最高，尺寸固定，角色可出三视角", () => {
  const style = { id: "donghua3d", prompt: donghuaStylePrompt };
  const content = filledContent.replace(
    "Subject: none",
    "Subject: youth Chinese male disciple Shen Buyan",
  );
  const prompt = assetVisualPrompt(style, {
    kind: "character",
    promptFormat: "character-content-v1",
    prompt: content,
    identity: "",
    state: "",
  });
  expect(prompt.startsWith(sharedStyleDna)).toBe(true);
  expect(prompt.endsWith(selectedVisualStyleRule(style))).toBe(true);
  expect(prompt).toContain("SERIES LOOK BRIEF");
  expect(prompt).toContain("series-wide character sheet");
  expect(prompt).toContain("Style feel: same series as every other sheet");
  expect(prompt).toContain(characterLookAngleLine("three-quarter"));
  const front = assetVisualPrompt(style, {
    kind: "character",
    promptFormat: "character-content-v1",
    prompt: content,
    identity: "",
    state: "",
  }, [], { angle: "front" });
  expect(front).toContain("Look angle: front");
  expect(front.startsWith(sharedStyleDna)).toBe(true);
  expect(front.endsWith(selectedVisualStyleRule(style))).toBe(true);
  const plaque = compileXianxiaLook(
    "scene",
    filledScene.replace(
      "Set dressing: none",
      "Set dressing: lintel plaque 门楣匾额写「青梧宗」三字",
    ),
  );
  expect(plaque).toContain('the lintel plaque reads "青梧宗"');
  expect(lookSheetOptions({ visualRevision: 2 })).toEqual({
    visualRevision: 2,
    aspect: lookSheetAspect,
    resolution: lookSheetResolution,
  });
  expect(lookSheetAspect).toBe("3:4");
  expect(lookSheetResolution).toBe("2k");
});

test("画风管感觉、登记管身份：素衣角色的 brief 不再禁掉仙气，只锁身份差异", () => {
  const plain = filledContent
    .replace("Subject: none", "Subject: youth Chinese woman xianxia envoy in medicine-team guise, wilted slender build")
    .replace("Face: none", "Face: withered sparse brows, weary downcast eyes, narrow jaw, still bitter in-character look")
    .replace("Hair: none", "Hair: dry withered brown, long, loose")
    .replace("- Inner robe: none", "- Inner robe: undyed plain cross-collar")
    .replace("- Outer robe: none", "- Outer robe: extremely plain medicine robe");
  const facts = {
    name: "取相使·苦哀",
    identity: "取相使枯萝。苦、哀。可混在药师队中。设定未写年长。",
    form: "极素药师衣。发枯，唇也枯。苦着一张不争的脸。",
  };
  const locked = `UNIVERSAL XIANXIA STYLE
Chinese 3D xianxia donghua from one same series.
Immortal xianxia look: tall slender proportions; layered xianxia tailoring; very wide sleeves; trailing silk ribbons and tassels; sheer gauze over dark teal-black robes; fabric lifted as if by mountain wind even when the figure stands still.
Finish: stylized 3D donghua, manhua-immortal faces, clear cold immortal aura, luxurious but restrained.
Same visual family for characters, props, and sets.`;
  const brief = assetVisualPrompt(
    { id: "donghua3d", prompt: locked, version: "xianxia-universal-v1" },
    { kind: "character", name: facts.name, promptFormat: "character-content-v1", prompt: plain, identity: facts.identity, state: "" },
    [],
    { facts },
  );
  // 身份差异保留
  expect(brief).toContain("undyed plain cross-collar");
  expect(brief).toContain("extremely plain medicine robe");
  expect(brief).toContain("withered sparse brows");
  // 不再把画风里的仙气当成「登记没写就禁止」
  for (const forbidden of [
    "Do not add gauze",
    "Do not add motifs",
    "Do not add jade plaques or tassels",
    "Do not add unrequested ornaments",
    "Keep a single-layer xianxia robe",
    "no separate inner color was given",
  ])
    expect(brief).not.toContain(forbidden);
  // 明确写：媒介、脸、光、仙气跟着画风走；只有登记写死的差异才锁
  expect(brief).toMatch(/Style feel:.*same series/i);
  expect(brief).toMatch(/manhua-immortal face|donghua face/i);
  expect(brief).toMatch(/plain cloth still reads as (this|the same) xianxia/i);
  expect(lookBriefIssues("character", brief, facts)).toEqual([]);
});

test("同一画风、不同人物：画风句完全一致，身份句各不相同，比喻译成画面", () => {
  const style = { id: "donghua3d", prompt: donghuaStylePrompt, version: donghuaStyleVersion };
  const silver = filledContent
    .replace("Subject: none", "Subject: youth Chinese male xianxia sword lord, tall slender build")
    .replace("Face: none", "Face: pale skin, long sharp brows, cold grey eyes, thin lips, narrow jaw, small dark leaf-shaped forehead mark")
    .replace("Hair: none", "Hair: silver-white, waist length, high topknot with jade pin and dangling chain, loose strands")
    .replace("- Inner robe: none", "- Inner robe: white cross-collar silk")
    .replace("- Outer robe: none", "- Outer robe: black ankle-length wide sleeves")
    .replace("- Embroidery: none", "- Embroidery: silver vine scrollwork in silver thread");
  const healer = filledContent
    .replace("Subject: none", "Subject: youth Chinese woman xianxia healer, wilted slender build")
    .replace("Face: none", "Face: withered sparse brows, weary downcast eyes, narrow jaw, dry lips like vine left in water too long, still bitter look")
    .replace("Hair: none", "Hair: dry brown, long, loose, like straw after rain")
    .replace("- Inner robe: none", "- Inner robe: undyed plain cross-collar")
    .replace("- Outer robe: none", "- Outer robe: extremely plain grey medicine robe");
  const a = assetVisualPrompt(style, { kind: "character", name: "银发剑主", promptFormat: "character-content-v1", prompt: silver, identity: "", state: "" });
  const b = assetVisualPrompt(style, { kind: "character", name: "药师", promptFormat: "character-content-v1", prompt: healer, identity: "", state: "" });
  // 画风层完全相同
  const head = (p: string) => p.slice(0, p.indexOf("SERIES LOOK BRIEF"));
  expect(head(a)).toBe(head(b));
  expect(head(a)).toContain(sharedStyleDna);
  expect(head(a)).toContain(characterSheetModule);
  const feel = (p: string) => p.split("\n").find((line) => line.startsWith("Style feel:"));
  expect(feel(a)).toBe(feel(b));
  // 身份层各不相同
  expect(a).toContain("silver-white, waist length, high topknot with jade pin and dangling chain");
  expect(a).toContain("small dark leaf-shaped forehead mark");
  expect(a).toContain("silver vine scrollwork in silver thread");
  expect(b).toContain("dry brown, long, loose");
  expect(b).toContain("extremely plain grey medicine robe");
  expect(b).not.toContain("silver-white");
  expect(a).not.toContain("withered");
  // 比喻不进生图词，只留画面
  expect(b).toContain("dry lips");
  expect(b).not.toMatch(/like vine|like straw/);
  for (const p of [a, b]) {
    expect(p).not.toMatch(/Do not add gauze|Do not add motifs|Keep a single-layer|no separate inner color/);
    expect(p.endsWith(selectedVisualStyleRule(style))).toBe(true);
  }
});

test("空眼与比喻脸的 CONTENT 编译后被改写，不算漂移，出图门能过", () => {
  const style = { id: "donghua3d", prompt: donghuaStylePrompt, version: donghuaStyleVersion };
  const emptyEye = filledContent
    .replace("Subject: none", "Subject: youth Han man xianxia Phixiang Hall master, tall youth impression")
    .replace("Face: none", "Face: scorched-gold flush face-plate fused to the face, brow ridge of the plate, empty-eye wells as two open holes, sealed lip line of the plate")
    .replace("Hair: none", "Hair: ink-black, long, loose behind the plate");
  const facts = { name: "空眼殿主", identity: "空眼面具贴面，殿主。", form: "贴面空板，两口空井。" };
  const generationPrompt = assetVisualPrompt(style, { kind: "character", name: facts.name, promptFormat: "character-content-v1", prompt: emptyEye, identity: facts.identity, state: "" }, [], { facts });
  expect(generationPrompt).toContain("Face: a blank plate flush to the face with only two punched open wells");
  expect(generationPrompt).toContain("the blank plate sits where the face would be");
  expect(generationPrompt).not.toMatch(/Style feel:[^\n]*manhua-immortal face/);
  expect(assetContentDrifted({ kind: "character", prompt: emptyEye, generationPrompt })).toBe(false);

  const simile = filledContent
    .replace("Subject: none", "Subject: youth Han woman xianxia healer")
    .replace("Face: none", "Face: withered dry lips like vine left in water too long, drooping brows, downcast eyes");
  const similePrompt = assetVisualPrompt(style, { kind: "character", promptFormat: "character-content-v1", prompt: simile, identity: "", state: "" });
  expect(similePrompt).not.toContain("like vine");
  expect(assetContentDrifted({ kind: "character", prompt: simile, generationPrompt: similePrompt })).toBe(false);
  // 真改了脸才算漂移
  expect(assetContentDrifted({ kind: "character", prompt: simile.replace("withered dry lips", "full red lips, bright smiling eyes"), generationPrompt: similePrompt })).toBe(true);
});

test("英文字段里的 no X 只删这一项，不吞掉后面的脸；三视角也按登记编译空眼", () => {
  expect(
    affirmativeLookText(
      "scorched-gold mixed with bone-lacquer, brows washed into the face, empty gaze with two open holes and no pupils, mouth line washed away, jaw washed into shadow",
    ),
  ).toBe(
    "scorched-gold mixed with bone-lacquer, brows washed into the face, empty gaze with two open holes, mouth line washed away, jaw washed into shadow",
  );
  expect(affirmativeLookText("thin lips with no beard, long jaw")).toBe("thin lips, long jaw");
  const style = { id: "donghua3d", prompt: donghuaStylePrompt, version: donghuaStyleVersion };
  const emptyEye = filledContent
    .replace("Subject: none", "Subject: youth Han woman xianxia phase-taker")
    .replace("Face: none", "Face: flush empty-eye face-plate, two open empty wells, crimson lip line painted on the plate");
  const facts = { name: "取相使·媚诱", identity: "取相使绛无音。媚、诱。", form: "空眼面具仍空着眼，却描了绛色唇线。" };
  for (const angle of ["front", "side"] as const) {
    const view = assetVisualPrompt(style, { kind: "character", name: facts.name, promptFormat: "character-content-v1", prompt: emptyEye, identity: facts.identity, state: "" }, [], { angle, facts });
    expect(view).toContain("Face: a blank plate flush to the face with only two punched open wells");
    expect(view).toContain(`Look angle: ${angle}`);
    expect(lookBriefIssues("character", view, facts)).toEqual([]);
  }
});

test("旧版内置仙侠原文在界面上显示为现行原文，作品自加的尾句保留", () => {
  const v1 = `UNIVERSAL XIANXIA STYLE
Chinese 3D xianxia donghua from one same series.
Finish: stylized 3D donghua, manhua-immortal faces, clear cold immortal aura, luxurious but restrained.
Same visual family for characters, props, and sets.
作品额外要求：暖金色轮廓光。`;
  const v3 = `UNIVERSAL XIANXIA STYLE
High-finish 3D CGI Chinese xianxia production look from one same series — the same render family as a luxury immortal-drama character sheet.
Same visual family for characters, props, and sets.`;
  expect(normalizedXianxiaDna(v1)).toBe(`${sharedStyleDna}\n作品额外要求：暖金色轮廓光。`);
  expect(normalizedXianxiaDna(v3)).toBe(sharedStyleDna);
  expect(normalizedXianxiaDna(sharedStyleDna)).toBe(sharedStyleDna);
  expect(normalizedXianxiaDna("UNIVERSAL XIANXIA STYLE\n用户自定原文")).toBe("UNIVERSAL XIANXIA STYLE\n用户自定原文");
  expect(normalizedXianxiaDna("赛璐璐")).toBe("赛璐璐");
  expect(normalizedXianxiaDna(v1)).not.toContain("undefined");
});

test("编译对照登记：鸟不加袍、树不加台、符不改玉牌、匣不改圆盒", () => {
  const bird = filledContent
    .replace("Subject: none", "Subject: small cyan xianxia spirit bird 岁岁")
    .replace("Only this one person in frame.", "Only this one bird in frame.");
  const birdFacts = { name: "古梧青鸟", identity: "岁岁。与通天古梧共生的青鸟。", form: "青羽。" };
  const birdPrompt = assetVisualPrompt(
    { id: "donghua3d", prompt: donghuaStylePrompt },
    { kind: "character", name: "古梧青鸟", promptFormat: "character-content-v1", prompt: bird, identity: birdFacts.identity, state: "青羽" },
    [],
    { facts: birdFacts },
  );
  expect(birdPrompt).toContain(creatureSheetModule);
  expect(birdPrompt).toContain("No garments");
  expect(birdPrompt).not.toContain("xianxia robe construction");
  expect(birdPrompt).not.toContain("Keep a single-layer xianxia robe");
  expect(lookBriefIssues("character", birdPrompt, birdFacts)).toEqual([]);

  const shadow = filledContent
    .replace("Subject: none", "Subject: unnamed 取相残使")
    .replace("Face: none", "Face: washed-away features, empty gaze without pupils");
  const shadowFacts = {
    name: "取相残使",
    identity: "未具名的噬相殿窥伺。空而无瞳，面目可不清。",
    form: "轮廓为焦金与枯骨漆混在一起的暗影，像被洗掉五官的脸。",
  };
  expect(lookContentIssues("character", shadow.replace("Inner robe: none", "Inner robe: cyan xianxia robe"), shadowFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("穿袍")]),
  );
  const shadowBrief = compileXianxiaLook("character", shadow, "three-quarter", shadowFacts);
  // 暗影是一整块不透明的漆色剪影，不能写成“没穿衣服”的人体，否则模型画出裸身、供应商审核直接拒绝。
  expect(shadowBrief).toContain("fully opaque silhouette");
  expect(shadowBrief).toContain("not as a bare body");
  expect(shadowBrief).not.toContain("No garments, no separate robe, no boots");
  expect(shadowBrief).not.toContain("xianxia robe construction");
  expect(shadowBrief).not.toContain("Keep a single-layer xianxia robe");
  expect(lookBriefIssues("character", shadowBrief, shadowFacts)).toEqual([]);

  const tree = filledScene
    .replace("Place: none", "Place: tongtian ancient wutong")
    .replace("Enclosure: none", "Enclosure: outdoor open terrace")
    .replace("Camera: none", "Camera: wide open terrace");
  const treeFacts = { name: "通天古梧", identity: "冠看不见顶，根看不见底", form: "通天巨梧，根冠入云海" };
  expect(
    lookContentIssues("scene", tree, treeFacts),
  ).toEqual(expect.arrayContaining([expect.stringContaining("高台")]));
  const repairedTree = repairLookPrompt("scene", tree, treeFacts);
  expect(repairedTree).toContain("standing tree in cloud");
  expect(lookContentIssues("scene", repairedTree, treeFacts)).toEqual([]);
  const treeBrief = compileXianxiaLook("scene", repairedTree, "three-quarter", treeFacts);
  expect(treeBrief).not.toContain("Architecture: keep this an open terrace or platform");
  expect(lookBriefIssues("scene", treeBrief, treeFacts)).toEqual([]);

  const talisman = filledProp
    .replace("Item: none", "Item: jade token")
    .replace("Form: none", "Form: rectangular plaque");
  const talismanFacts = { name: "年轮拓印符", identity: "掌中灵脉符。古梧年轮拓印。", form: "符面是古梧的年轮拓印" };
  expect(
    lookContentIssues("prop", talisman, talismanFacts),
  ).toEqual(expect.arrayContaining([expect.stringContaining("玉牌")]));
  const repairedTalisman = repairLookPrompt("prop", talisman, talismanFacts);
  expect(repairedTalisman).toContain("year-ring rubbing talisman");
  expect(repairedTalisman).not.toContain("jade token");
  expect(lookContentIssues("prop", repairedTalisman, talismanFacts)).toEqual([]);

  const casket = filledProp
    .replace("Item: none", "Item: box")
    .replace("Form: none", "Form: round box, lid closed");
  const casketFacts = { name: "未开的定相匣", identity: "未用的定相秘丹及其匣", form: "未打开的丹匣，可收袖中" };
  expect(
    lookContentIssues("prop", casket, casketFacts),
  ).toEqual(expect.arrayContaining([expect.stringContaining("圆盒")]));
  const repairedCasket = repairLookPrompt("prop", casket, casketFacts);
  expect(repairedCasket).toContain("rectangular closed casket");
  expect(lookContentIssues("prop", repairedCasket, casketFacts)).toEqual([]);

  const sword = filledContent.replace(
    "- Other accessories: none",
    "- Other accessories: no weapon",
  );
  const swordFacts = {
    name: "青梧大师兄",
    identity: "青梧大师兄沈不言。沉默剑修。",
    form: "外袍，腰侧佩剑归鞘，剑穗下垂。",
  };
  expect(
    lookContentIssues("character", sword, swordFacts),
  ).toEqual(expect.arrayContaining([expect.stringContaining("归鞘")]));
  const repairedSword = repairLookPrompt("character", sword, swordFacts);
  expect(repairedSword).toContain("sheathed sword at the waist side");
  expect(lookContentIssues("character", repairedSword, swordFacts)).toEqual([]);

  const aged = filledContent.replace(
    "Subject: none",
    "Subject: youth 华夏 man xianxia 沈不言, father-brother stature, broad shoulders",
  );
  const agedFacts = {
    name: "青梧大师兄",
    identity: "青梧大师兄沈不言。沉默剑修，父兄式身量。设定未写年长。",
    form: "外袍",
    ageBand: "youth",
  };
  expect(lookContentIssues("character", aged, agedFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("年长")]),
  );
  const repairedAge = repairLookPrompt("character", aged, agedFacts);
  expect(repairedAge).not.toMatch(/father-brother/i);
  expect(lookContentIssues("character", repairedAge, agedFacts)).toEqual([]);
  const ageBrief = compileXianxiaLook("character", aged, "three-quarter", agedFacts);
  expect(ageBrief).not.toMatch(/father-brother/i);
  expect(ageBrief).toMatch(/Subject: youth/i);
  expect(lookBriefIssues("character", ageBrief, agedFacts)).toEqual([]);
});

test("山门剑崖外门的 Camera 不能抄成高台，问道台可以", () => {
  const leaked = filledScene
    .replace("Place: none", "Place: grain cliff")
    .replace("Enclosure: none", "Enclosure: grain cliff")
    .replace("Camera: none", "Camera: wide open terrace");
  const cliffFacts = { name: "剑崖", identity: "青梧宗剑崖", form: "崖上有梧桐木纹" };
  expect(lookContentIssues("scene", leaked, cliffFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("高台")]),
  );
  const repairedCliff = repairLookPrompt("scene", leaked, cliffFacts);
  expect(repairedCliff).toContain("Camera: wide grain cliff");
  expect(repairedCliff).not.toMatch(/Camera:.*open terrace/);
  expect(lookContentIssues("scene", repairedCliff, cliffFacts)).toEqual([]);
  expect(compileXianxiaLook("scene", leaked, "three-quarter", cliffFacts)).toContain(
    "Camera: wide grain cliff",
  );

  const cliffTerrace = filledScene
    .replace("Place: none", "Place: 问剑处")
    .replace("Enclosure: none", "Enclosure: outdoor open terrace")
    .replace("Camera: none", "Camera: wide open terrace");
  expect(lookContentIssues("scene", cliffTerrace, cliffFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("高台")]),
  );
  const repairedCliffTerrace = repairLookPrompt("scene", cliffTerrace, cliffFacts);
  expect(repairedCliffTerrace).toContain("Enclosure: grain cliff");
  expect(repairedCliffTerrace).not.toMatch(/Enclosure:.*open terrace/);
  const cliffBrief = compileXianxiaLook("scene", cliffTerrace, "three-quarter", cliffFacts);
  expect(cliffBrief).toContain("Enclosure: grain cliff");
  expect(cliffBrief).toContain("Camera: wide grain cliff");
  expect(cliffBrief).not.toContain("Architecture: keep this an open terrace or platform");

  const gate = filledScene
    .replace("Place: none", "Place: sect mountain gate")
    .replace("Enclosure: none", "Enclosure: mountain gate")
    .replace("Camera: none", "Camera: wide open terrace");
  const gateFacts = {
    name: "梧桐木纹山门",
    identity: "青梧宗山门。通天古梧所在的山门。",
    form: "梧桐木纹门柱，山门石阶",
  };
  expect(lookContentIssues("scene", gate, gateFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("高台")]),
  );
  expect(repairLookPrompt("scene", gate, gateFacts)).toContain("Camera: wide mountain gate");

  const yard = filledScene
    .replace("Place: none", "Place: empty stone yard")
    .replace("Enclosure: none", "Enclosure: empty stone yard")
    .replace("Camera: none", "Camera: wide open terrace");
  const yardFacts = { name: "外门青石", identity: "外门青石坪", form: "外门青石。可停木车" };
  expect(lookContentIssues("scene", yard, yardFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("高台")]),
  );
  expect(repairLookPrompt("scene", yard, yardFacts)).toContain("Camera: wide empty stone yard");

  const yardTerrace = filledScene
    .replace("Place: none", "Place: 青石坪")
    .replace("Enclosure: none", "Enclosure: outdoor open terrace")
    .replace("Camera: none", "Camera: wide open terrace");
  expect(lookContentIssues("scene", yardTerrace, yardFacts)).toEqual(
    expect.arrayContaining([expect.stringContaining("高台")]),
  );
  const yardBrief = compileXianxiaLook("scene", yardTerrace, "three-quarter", yardFacts);
  expect(yardBrief).toContain("Enclosure: empty stone yard");
  expect(yardBrief).not.toContain("Architecture: keep this an open terrace or platform");

  const terrace = filledScene
    .replace("Place: none", "Place: open white-stone platform")
    .replace("Enclosure: none", "Enclosure: outdoor open terrace")
    .replace("Camera: none", "Camera: wide open terrace");
  const terraceFacts = { name: "盟会问道台", identity: "白石问道高台", form: "白石高台，台高过人头" };
  expect(lookContentIssues("scene", terrace, terraceFacts)).toEqual([]);
  expect(repairLookPrompt("scene", terrace, terraceFacts)).toContain("Camera: wide open terrace");
});

test("空瞳窥伺不被同实体的空眼残面具改成贴面空板", () => {
  const facts = {
    name: "空瞳窥伺",
    identity: "未具名的噬相殿窥伺。空而无瞳，面目可不清。",
    form: "轮廓为焦金与枯骨漆混在一起的暗影，像被洗掉五官的脸。目光空、没有瞳仁。",
    registry: JSON.stringify({
      name: "取相残使",
      variants: [
        { name: "空瞳窥伺", identity: "空而无瞳", form: "暗影，洗掉五官" },
        { name: "空眼残面具", form: "空眼面具裂到鼻梁" },
      ],
    }),
  };
  const face = "Face: features washed away, empty gaze with no pupils, lips unclear, jaw unclear";
  const zh = "Face: 五官洗掉，目光空、没有瞳仁，唇不清，颌不清";
  expect(lookContentIssues("character", face, facts)).toEqual([]);
  expect(lookContentIssues("character", zh, facts)).toEqual([]);
  expect(repairLookPrompt("character", face, facts)).toContain("features washed away");
  expect(repairLookPrompt("character", face, facts)).not.toContain("blank plate flush to the face");
  expect(
    compileXianxiaLook("character", filledContent.replace("Face: none", face), "three-quarter", facts),
  ).not.toContain("blank plate flush to the face");
});

test("枯萝袖中的空眼残片不能把苦脸改成贴面空板", () => {
  const facts = {
    name: "取相使·苦哀",
    identity: "取相使枯萝。苦、哀。可混在药师队中。设定未写年长。",
    form: "极素药师衣。发枯，唇也枯，像泡过太久的藤。苦着一张不争的脸。袖可藏倒置年轮灰与空眼残片。",
  };
  const plate = "Face: a blank plate flush to the face with only two punched open wells, mouth covered by the plate";
  const face = "Face: withered healer face, dry lips, uncontending bitter expression, unique marks none";
  expect(lookContentIssues("character", plate, facts)).toEqual(
    expect.arrayContaining([expect.stringContaining("贴面空板")]),
  );
  expect(lookContentIssues("character", face, facts)).toEqual([]);
  expect(
    compileXianxiaLook("character", filledContent.replace("Face: none", face), "three-quarter", facts),
  ).not.toContain("blank plate flush to the face");
});

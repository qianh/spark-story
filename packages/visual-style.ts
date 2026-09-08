export const donghuaStyleVersion = "xianxia-style-dna-v2";

export const sharedStyleDna = `SHARED STYLE DNA — never change across characters, props, or scenes:

High-finish 3D photorealistic cinematic xianxia production look.
Movie-grade materials: silk and gauze with readable weave and drape; dense fine embroidery as stitched thread not decals; jade slightly translucent; metal softly brushed, not chrome; wood with tight grain; stone with dry cool mineral surface.
Color science: cool restrained palette, dark teal-black / ink / bone-white / muted jade / aged bronze; no neon, no candy saturation.
Lighting language: naturalistic cinematic light, clear key direction, soft rim on edges, volumes readable, no beauty-filter glow, no magical bloom unless the content module explicitly asks for a contained effect.
Mood: luxurious yet restrained, cold quiet immortal world, melancholy stillness, photoreal 3D, not anime, not illustration, not painterly concept sketch.
No watermark, no text, no logo, no extra modern objects.`;

export const characterSheetModule = `MODULE — CHARACTER SHEET:
Vertical full-body standing portrait, slight three-quarter, feet and ground visible.
Clean shallow neutral cool taupe-gray studio backdrop.
Key light from front-left on the face, soft rim on hair and sleeves.
Only one person. Clothes intact and dry.
Forbidden: landscape, architecture, sky, fog environment, weapons in action, spell effects, extra people.`;

export const propSheetModule = `MODULE — PROP SHEET:
Hero prop product shot for the same xianxia series.
Centered or slight three-quarter, fully visible, sharp silhouette, no crop through important ornaments.
Support: clean shallow studio, or a single period-correct surface only (dark wood table / raw stone slab). No room, no landscape behind.
Lighting: same key-from-front-left plus soft rim that reads engraving, jade, tassel and metal edges.
Scale readable. One hero prop only, or a tightly related set if content says so.
Forbidden: hands unless content asks for a holding crop, characters, mountains, pavilions, spell beams, particles, floating UI.`;

export const sceneSheetModule = `MODULE — SCENE SHEET:
Cinematic establishing or empty-set plate from the same xianxia series.
Wide or full-set view, stable camera, architecture and space readable, not a character poster.
Lighting: naturalistic cinematic daylight, dry and readable, same cool restrained grade, no rain, no night, no extinguished lamps. Volumes of distant haze only as ordinary landscape depth, not plot weather.
World logic: traditional Eastern immortal architecture and landscape, materials match the costume world (stone, timber, tile, silk screens, bronze fittings).
Forbidden: modern buildings, cars, power lines, anime sky, over-saturated sunset postcard, crowded extras, readable signage text.`;

/** Catalog `prompt` is the shared DNA. Character STYLE LOCK is now DNA + character module. */
export const donghuaStylePrompt = sharedStyleDna;

export const xianxiaProductionPrompt = sharedStyleDna;

export const characterStyleClosing =
  "High-finish consistent series look, same camera, same lighting rig, same fabric logic, same background family.";

export const characterContentTemplate = `CONTENT — replace per character:

Subject: [age] [ethnicity] [gender] xianxia [identity], [body: height impression, shoulder, waist, build].

Face: [skin note if not default porcelain], [brow], [eye shape + gaze], [nose], [lips], [jaw], [expression], [unique marks or none].

Hair: [color], [length], [how it is worn], [sideburns / bangs], [must-have hairpiece or none].

Costume specific to this character:
- Inner robe: [color] [collar type] [fabric]
- Outer robe: [color] [length] [sleeve note]
- Overlay: [sheer color / none]
- Embroidery motif: [motif / none] in [silver / same-color] thread
- Sash and waist: [plain silk only / jade plaques + tassels / unique pendant]
- Unique accessories: [accessories / none]
- Shoes: [dark cloth boots / other]

Pose: standing upright, hands hanging naturally at sides, weight even, no action pose.
Only this one person in frame.`;

export const propContentTemplate = `PROP CONTENT:
Item: [name / type]
Size impression: [slender long / compact palm-size / two-handed]
Materials: [iron / bronze / white jade / zitan wood / dark silk wrap]
Form: [straight blade / flared hilt / rectangular plaque / round box]
Ornament: [fine silver-thread motif / wutong / cloud / crane / plain]
Color accents: [dark teal cord / muted jade inlay / bone-white tassel]
Condition: intact, dry, slightly aged but well kept, not rusty wreck
Unique marks: [inscription / clan emblem / crack / none]
View: [full item three-quarter / front + slight top]`;

export const sceneContentTemplate = `SCENE CONTENT:
Place: [mountain gate / cliff pavilion / inner meditation hall / bamboo courtyard / stone stair]
Time / weather: default dry daylight — do not fill night, rain, or lamps-off
Space: [what is near camera, what is mid, what is far]
Key structures: [roof type, columns, railings, stone steps, screens]
Materials on site: [grey granite, dark timber, grey tile, paper windows]
Set dressing: [one incense table / hanging lantern / sword rack / none]
Atmosphere: [still dry air / ordinary distant haze]
People: none
Camera: [wide establishing / medium courtyard / looking down a corridor]`;

export type VisualStyle = {
  id: string;
  prompt: string;
  productionPrompt?: string;
  characterModule?: string;
  propModule?: string;
  sceneModule?: string;
  version?: string;
};

export function xianxiaModules(style: VisualStyle) {
  if (style.characterModule && style.propModule && style.sceneModule)
    return {
      dna: style.prompt.startsWith("SHARED STYLE DNA")
        ? style.prompt
        : sharedStyleDna,
      character: style.characterModule,
      prop: style.propModule,
      scene: style.sceneModule,
    };
  if (style.prompt.startsWith("SHARED STYLE DNA"))
    return {
      dna: style.prompt,
      character: characterSheetModule,
      prop: propSheetModule,
      scene: sceneSheetModule,
    };
  return null;
}

export function exclusivePropsForCharacter(
  character: { name?: string; kind: string },
  assets: { name: string; kind: string; identity?: string }[] = [],
) {
  if (character.kind !== "character" || !character.name) return [];
  const characterName = character.name;
  return assets.filter((p) => {
    if (p.kind !== "prop") return false;
    const owned =
      p.name.startsWith(characterName) ||
      (p.identity || "").includes(characterName);
    if (!owned) return false;
    return !/衣|袍|裳|衫|服|布/.test(p.name);
  });
}

export function prepareAssetForLook(
  asset: {
    name?: string;
    kind: string;
    prompt: string;
    promptFormat?:
      | "visual-description-v1"
      | "character-content-v1"
      | "prop-content-v1"
      | "scene-content-v1";
    identity: string;
    state: string;
  },
  assets: { name: string; kind: string; identity?: string }[] = [],
) {
  const props = exclusivePropsForCharacter(asset, assets);
  if (!props.length) return asset;
  const names = props.map((p) => p.name);
  const hasSword = names.some((n) => /剑/.test(n));
  let { identity, state, prompt } = asset;
  if (hasSword) {
    identity = identity
      .replace(/，左肋素鞘长剑/g, "")
      .replace(/左肋素鞘长剑[。；]?/g, "")
      .replace(/腰素绦，左肋素鞘长剑/g, "腰素绦");
    state = state.replace(/剑在腰侧未出[。；]?/g, "");
    prompt = prompt
      .replace(/左手松扣剑格但剑未出，?/g, "双手自然垂下，")
      .replace(/左肋素鞘长剑，?/g, "")
      .replace(/腰侧素鞘长剑，?/g, "");
    if (asset.promptFormat === "character-content-v1") {
      prompt = prompt.replace(
        /- Unique accessories:.*$/m,
        "- Unique accessories: no weapon",
      );
    } else {
      prompt += `已有独立道具：${names.join("、")}，角色定妆不画这些物件${hasSword ? "，腰侧无剑、手中无剑" : ""}。`;
    }
  } else if (asset.promptFormat !== "character-content-v1") {
    prompt += `已有独立道具：${names.join("、")}，角色定妆不画这些物件。`;
  }
  return { ...asset, identity, state, prompt };
}

function joinLook(dna: string, moduleText: string, content: string) {
  return `${dna}\n\n${moduleText}\n\n${content}`;
}

export function assetVisualPrompt(
  style: VisualStyle,
  asset: {
    name?: string;
    kind: string;
    prompt: string;
    promptFormat?: "visual-description-v1" | "character-content-v1" | "prop-content-v1" | "scene-content-v1";
    identity: string;
    state: string;
  },
  assets: { name: string; kind: string; identity?: string }[] = [],
) {
  const modules = xianxiaModules(style);
  if (modules) {
    asset = prepareAssetForLook(asset, assets);
    if (asset.kind === "character") {
      assertCharacterContent(asset.prompt);
      return joinLook(modules.dna, modules.character, asset.prompt);
    }
    if (asset.kind === "prop") {
      if (asset.promptFormat === "prop-content-v1") assertPropContent(asset.prompt);
      return joinLook(modules.dna, modules.prop, asset.prompt);
    }
    if (asset.promptFormat === "scene-content-v1") assertSceneContent(asset.prompt);
    return joinLook(modules.dna, modules.scene, asset.prompt);
  }
  if (asset.kind === "character" && style.prompt.startsWith("STYLE LOCK —")) {
    assertCharacterContent(asset.prompt);
    return `${style.prompt}\n\n${compileCharacterContent(asset.prompt)}\n\n${characterStyleClosing}`;
  }
  if (style.prompt.startsWith("STYLE LOCK —") && asset.kind !== "character") {
    const rendering = productionVisualPrompt(style);
    const framing =
      asset.kind === "scene"
        ? "Environment asset: show only the described location, architecture, terrain and vegetation. Establish clear spatial layout and architectural scale. Readable cinematic daylight, gentle fill, natural stone and wood material response. No people, human figures, animals, portrait studio backdrop or unrequested spell effects."
        : "Prop asset: show only the described object, with its entire shape visible against a clean cool taupe-gray studio backdrop. Front-left key light, soft cool rim light and gentle fill. Readable textile stitches, slightly translucent jade and softly brushed metal where present. No person, mannequin or body parts. Preserve the object's specified wear, breaks and fragments.";
    const content =
      asset.promptFormat === "visual-description-v1"
        ? asset.prompt
        : `${asset.prompt}\n${asset.identity}\n${asset.state}`;
    return `${rendering}\n\n${framing}\n\n${content}`;
  }
  asset = prepareAssetForLook(asset, assets);
  const composition =
    asset.kind === "character"
      ? "单角色全身定妆照，全身从头到脚完整入镜，人物占画面高度约85%，头顶与靴底留出边距，脚下可见地面。中性可读光，衣物干燥。单幅图。"
      : asset.kind === "scene"
        ? "场景资产，重点呈现空间关系、建筑与纵深，不额外添加人物。清晰可读的标准外观。"
        : "独立道具资产，完整呈现形制与材质，不额外添加人物。物件干燥完好。";
  if (asset.promptFormat === "visual-description-v1") {
    return `${style.prompt}\n${asset.prompt}\n${composition}`;
  }
  const content =
    style.id === "donghua3d"
      ? asset.prompt
          .split(/(?<=[。！；\n])/)
          .filter((sentence) => {
            if (
              /^(身份|服饰|状态|姿态|场景|动作|构图)[：:]/.test(sentence.trim())
            )
              return true;
            return !/影视级|虚幻引擎|UE写实|三维仙侠国漫|冷青灰主调|禁止二次元|不要画成任何现有动画|网红磨皮|次表面散射/.test(
              sentence,
            );
          })
          .join("")
      : asset.prompt;
  const look =
    style.id === "donghua3d" && asset.kind === "character"
      ? `高细节3D CGI仙侠全身定妆照。\n${style.prompt}`
      : style.prompt;
  return `${look}\n构图：${composition}\n资产内容：${content}\n固定身份：${asset.identity}\n当前状态：${asset.state}${style.id === "donghua3d" ? "\n融合要求：以本资产身份和状态决定内容，以以上画风决定造型、材质和布光。只输出一幅图。" : ""}`;
}

const plotWeather =
  /夜雨|秋雨|大雨|淋湿|湿透|打湿|雨珠|雨滴|雨帘|湿雾|体积雾|湿青石|深夜|夜间|夜色|黄昏|黎明|月光|熄灭的.{0,8}灯|秋末.{0,8}(夜|雨)|雨中/;
const plotPerformance =
  /高烧|额红|双眼紧闭|发烧|出剑|抱起|熄灯/;

export function lookPlotIssues(asset: {
  name?: string;
  prompt: string;
  identity?: string;
  state?: string;
}) {
  const issues: string[] = [];
  for (const [field, text] of [
    ["prompt", asset.prompt],
    ["identity", asset.identity || ""],
    ["state", asset.state || ""],
  ] as const) {
    const weather = text.match(plotWeather);
    if (weather)
      issues.push(
        `${asset.name || "资产"}的${field}含剧情天气或时段「${weather[0]}」，定妆只记录可复用外观`,
      );
    const performance = text.match(plotPerformance);
    if (performance)
      issues.push(
        `${asset.name || "资产"}的${field}含镜头状态「${performance[0]}」，定妆只记录可复用外观`,
      );
  }
  return issues;
}

export function assertCanonicalLooks(
  assets: {
    name?: string;
    prompt: string;
    identity?: string;
    state?: string;
  }[],
) {
  const issues = assets.flatMap(lookPlotIssues);
  if (issues.length) throw Error(`制作验收：${issues.join("；")}`);
}

export function assetLookAgentPrompt(
  stylePrompt: string,
  libraryJson: string,
  registryJson = "[]",
) {
  const modules = stylePrompt.startsWith("SHARED STYLE DNA") ||
    stylePrompt.startsWith("STYLE LOCK —");
  if (modules) {
    return `你是角色与资产 Agent。只根据外观登记和本集定妆需求填写定妆内容，不写本集剧情。角色 promptFormat="character-content-v1"，严格按 CONTENT 模板逐项填写；道具 promptFormat="prop-content-v1"；场景 promptFormat="scene-content-v1"。不适用写 none，未明确年龄不编造数字。内容不写 cinematic、史诗、仙气、电影感等风格词，不写画风 DNA 或模块锁。程序将原样拼接 SHARED STYLE DNA、对应 MODULE、CONTENT。
人物模板：
${characterContentTemplate}
道具模板：
${propContentTemplate}
场景模板：
${sceneContentTemplate}
场景 Time / weather 只能是 default dry daylight，People: none。禁止夜雨、黄昏、熄灯、高烧、闭眼、出剑。独立佩剑不画进角色，Unique accessories 写 no weapon。内容冲突时改内容，绝不改 DNA 或模块。只为本集需要且库中没有的实体和变体出项；门外、末阶等视图不要单独建资产。成长阶段用 variantKind=growth；换装用 costume；破败用 form。返回 JSON {"summary":"说明","assets":[{"id":"entityId:variantId","name":"名称","kind":"character或scene或prop","promptFormat":"character-content-v1或prop-content-v1或scene-content-v1","prompt":"填好的内容","identity":"固定身份","state":"可复用形制","entityId":"实体ID","variantId":"变体ID","variantKind":"growth或costume或form","growthStage":"child|teen|youth|adult|elder或空"}],"voices":[]}。
外观登记：${registryJson}
可复用库：${libraryJson}
作品公共画风 DNA（不要写入 prompt）：
${stylePrompt}`;
  }
  return `你是角色与资产 Agent。提取本集实际需要的角色、场景、道具，生成可跨集复用的定妆资产。定妆是身份与形制的画像，不是关键帧：不要写入本集天气、昼夜、临时湿衣、剧情动作或具体镜头场面。雨、夜、晴、雾等环境只属于后续关键帧。角色图是单角色全身站立定妆照，中性可读光，衣物干燥，背景简洁，不把多人拼在同一图。场景画地点在清晰光线下的标准建筑与空间，不画本集夜雨或熄灯。道具画物件干燥完好的标准形制，不画被雨水打湿或使用后的状态。画风必须遵守：${stylePrompt}。每项填写 promptFormat="visual-description-v1"。prompt 是一段可直接用于生图的完整中文画面描述，合并该资产可复用的身份、服饰形制和基础外观，各写一次，约150～300字；identity 与 state 用于资产库记录，不会再次拼入生图输入，所以其中影响外观的信息必须完整体现在 prompt。state 只写服装、年龄、伤势、能力阶段，不写天气和时段。用正向描述表达表情和气质，不堆叠同义禁令。不要写通用画风词、渲染词或中英双语翻译，程序会原样添加作品画风。美术表现严格使用当前画风，不重复加入真人写真或过时的写实渲染要求，不要改写成二维插画、水墨、赛璐璐或Q版，也不要写成任何现有动画角色的翻版。角色定妆只画身体、脸、头发和身上的衣服。已经单独列为 prop 的物件不要画进角色图：有佩剑资产则角色定妆无剑、不握剑、腰侧不挂剑。道具图是该物件的唯一外观来源，不要为了好看把道具画进角色定妆。本次只规划图像资产，voices 返回空数组；声音试听会在图像完成后独立规划。返回 JSON：{"summary":"说明","assets":[{"id":"稳定ID","name":"名字","kind":"character或scene或prop","promptFormat":"visual-description-v1","prompt":"完整中文画面描述","identity":"不变外貌","state":"服装、年龄、伤势或能力阶段"}],"voices":[{"character":"角色名字","voice":"可用ID","sampleText":"该角色一句适合试听的台词"}]}。从文字分镜 assetIds 提取全部需求并保持 ID 一致。已有资产可通过 libraryId 引用，必须选择外观与状态都匹配的版本；新增状态创建独立资产，并用 baseLibraryId 指定基础参考版本，不覆盖旧版。每项填写 identity 与 state。不要虚构 imageId、audioId。可复用库：${libraryJson}。`;
}

export function assertCharacterContent(content: string) {
  const labels = [
    "CONTENT — replace per character:",
    "Subject:",
    "Face:",
    "Hair:",
    "Costume specific to this character:",
    "- Inner robe:",
    "- Outer robe:",
    "- Overlay:",
    "- Embroidery motif:",
    "- Sash and waist:",
    "- Unique accessories:",
    "- Shoes:",
    "Pose:",
    "Only this one person in frame.",
  ];
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  if (
    lines.length !== labels.length ||
    labels.some((label, i) => !lines[i]?.startsWith(label)) ||
    /\[[^\]]+\]/.test(content) ||
    labels.some(
      (label, i) =>
        label.endsWith(":") && ![0, 4].includes(i) && lines[i] === label,
    )
  )
    throw Error("角色内容需按 CONTENT 模板逐项填写后再生成，不能直接使用旧版散文描述");
  if (
    /cinematic|STYLE LOCK|SHARED STYLE DNA|MODULE —|High-finish consistent series look|电影感|史诗|仙气|Lighting:|Background:/i.test(
      content,
    )
  )
    throw Error("CONTENT 只填写角色内容，画风 DNA 和模块锁由程序拼接");
}

export function assertPropContent(content: string) {
  const labels = [
    "PROP CONTENT:",
    "Item:",
    "Size impression:",
    "Materials:",
    "Form:",
    "Ornament:",
    "Color accents:",
    "Condition:",
    "Unique marks:",
    "View:",
  ];
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  if (
    lines.length !== labels.length ||
    labels.some((label, i) => !lines[i]?.startsWith(label)) ||
    /\[[^\]]+\]/.test(content)
  )
    throw Error("道具内容需按 PROP CONTENT 模板逐项填写");
}

export function assertSceneContent(content: string) {
  const labels = [
    "SCENE CONTENT:",
    "Place:",
    "Time / weather:",
    "Space:",
    "Key structures:",
    "Materials on site:",
    "Set dressing:",
    "Atmosphere:",
    "People:",
    "Camera:",
  ];
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  if (
    lines.length !== labels.length ||
    labels.some((label, i) => !lines[i]?.startsWith(label)) ||
    /\[[^\]]+\]/.test(content)
  )
    throw Error("场景内容需按 SCENE CONTENT 模板逐项填写");
  if (/night|rain|lamps-off|blue hour|light rain/i.test(content) &&
      !/default dry daylight/.test(content))
    throw Error("场景定妆只能是默认白天干燥空镜，夜雨熄灯属于关键帧");
  if (!/People:\s*none/i.test(content))
    throw Error("场景定妆 People 必须为 none");
}

export function productionVisualPrompt(style: VisualStyle) {
  if (xianxiaModules(style)) return style.prompt.startsWith("SHARED STYLE DNA")
    ? style.prompt
    : sharedStyleDna;
  if (!style.prompt.startsWith("STYLE LOCK —")) return style.prompt;
  if (style.productionPrompt) return style.productionPrompt;
  return sharedStyleDna;
}

export function compileCharacterContent(content: string) {
  assertCharacterContent(content);
  const positive: string[] = [];
  const negative: string[] = [];
  for (const line of content.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("CONTENT") || line === "Costume specific to this character:")
      continue;
    if (line === "Only this one person in frame.") {
      positive.push(line);
      continue;
    }
    const colon = line.indexOf(":");
    const label = line.slice(0, colon).replace(/^- /, "");
    const parts = line.slice(colon + 1).trim().replace(/\.$/, "").split(/,\s*/);
    const kept: string[] = [];
    for (const part of parts) {
      if (/^none(?: in .*thread)?$/i.test(part)) {
        if (["Overlay", "Embroidery motif", "Unique accessories", "Shoes"].includes(label))
          negative.push(
            `no ${label.toLowerCase() === "shoes" ? "footwear" : label.toLowerCase()}`,
          );
      } else if (/^no /i.test(part) && !["Face", "Hair"].includes(label))
        negative.push(part);
      else if (part) kept.push(part);
    }
    if (kept.length) positive.push(`${label}: ${kept.join(", ")}.`);
  }
  return `CONTENT\n${positive.join("\n")}\n\nEXCLUSIONS\n${[...new Set(negative)].join("; ") || "No additional subjects or unrequested accessories."}`;
}

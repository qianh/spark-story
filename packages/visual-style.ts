export const donghuaStyleVersion = "xianxia-3d-v8";

// Rendering language only. Age, temperament, costume and setting belong to each asset.
export const donghuaStylePrompt = "高细节3D CGI仙侠，《仙逆》动画的三维国漫画风，东方审美的精致立体造型，超写实面部与皮肤，精细发丝，衣料褶皱与刺绣精细，电影级戏剧光影，大师级画质。";

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
    promptFormat?: "visual-description-v1";
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
  }
  prompt += `已有独立道具：${names.join("、")}，角色定妆不画这些物件${hasSword ? "，腰侧无剑、手中无剑" : ""}。`;
  return { ...asset, identity, state, prompt };
}

export function assetVisualPrompt(
  style: { id: string; prompt: string },
  asset: {
    name?: string;
    kind: string;
    prompt: string;
    promptFormat?: "visual-description-v1";
    identity: string;
    state: string;
  },
  assets: { name: string; kind: string; identity?: string }[] = [],
) {
  asset = prepareAssetForLook(asset, assets);
  const composition =
    asset.kind === "character"
      ? "单角色全身定妆照，全身从头到脚完整入镜，人物占画面高度约85%，头顶与靴底留出边距，脚下可见地面。单幅图。"
      : asset.kind === "scene"
        ? "场景资产，重点呈现空间关系、建筑与纵深，不额外添加人物。"
        : "独立道具资产，完整呈现形制与材质，不额外添加人物。";
  // New plans contain one complete visual description; identity/state remain library metadata.
  if (asset.promptFormat === "visual-description-v1") {
    return `${style.prompt}\n${asset.prompt}\n${composition}`;
  }
  // Remove legacy rendering sentences while retaining editable staging and story details.
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

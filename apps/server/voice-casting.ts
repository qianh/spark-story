import { z } from "zod";
import {
  voicePortraitSchema,
  type AssetPlan,
  type Storyboard,
  type VoicePortrait,
  type VoiceSample,
} from "../../packages/media";

const visual =
  /衣|袍|发|骨|鼻|眉|靴|雨|叶|绣|锁骨|皮肤|场景|头骨|金叶|服饰|外貌|五官|湿/;
const ageLabel = {
  child: "幼童",
  teen: "少年",
  youth: "青年",
  adult: "中年",
  elder: "老年",
} as const;
const pitchLabel = {
  low: "低",
  "mid-low": "中低",
  mid: "中",
  "mid-high": "中高",
  high: "高",
} as const;
const paceLabel = {
  slow: "慢",
  "slightly-slow": "偏慢",
  medium: "中",
  "slightly-fast": "偏快",
} as const;

export function textLen(s: string) {
  return [...s.replace(/\s/g, "")].length;
}

export function voiceIdentityKey(
  gender: VoicePortrait["gender"],
  ageBand: VoicePortrait["ageBand"],
) {
  return `${gender}:${ageBand}`;
}

export function parseVoiceIdentity(identity: string) {
  const text = identity || "";
  const isMale = /男性|成年男子|青年男子|男人|男子|男孩|少年|老者|\bmale\b/i.test(text);
  const isFemale = /女性|成年女子|青年女子|女人|女孩|少女|老妇|幼女|\bfemale\b/i.test(text);
  if (isMale === isFemale) return null;
  const gender = isMale ? ("male" as const) : ("female" as const);
  let ageBand: VoicePortrait["ageBand"] | null = null;
  if (
    !/成年|青年|老年/.test(text) &&
    /幼女|幼童|幼儿|婴儿|儿童|小女孩|小男孩|\bchild\b/i.test(text)
  )
    ageBand = "child";
  else if (/老年|年迈|老者|老妇|\belder\b/i.test(text)) ageBand = "elder";
  else if (/青年|\byouth\b/i.test(text)) ageBand = "youth";
  else if (/少年|少女|\bteen\b/i.test(text)) ageBand = "teen";
  else if (/中年|成年|\badult\b/i.test(text)) ageBand = "adult";
  if (!ageBand) return null;
  return { gender, ageBand };
}

/** Read explicit subject metadata, never infer gender from a character name. */
export function voiceAssetIdentity(asset: AssetPlan["assets"][number]) {
  const subject = asset.prompt.match(/^Subject:[^\n]*/m)?.[0] || "";
  return [asset.identity, subject, asset.growthStage || ""].filter(Boolean).join("\n");
}

export function mergeVoiceCards(saved: VoiceSample[], updates: VoiceSample[]) {
  const key = (v: VoiceSample) => JSON.stringify([v.character, v.growthStage || ""]);
  const replaced = new Set(updates.map(key));
  return [...saved.filter(v => !replaced.has(key(v))), ...updates];
}

function assertAudible(text: string, label: string) {
  if (visual.test(text)) throw Error(`${label}含画面词，不能用于声音描述`);
}

function isYoungBand(ageBand: VoicePortrait["ageBand"]) {
  return ageBand === "child" || ageBand === "teen" || ageBand === "youth";
}

export function assertYoungVoice(portrait: VoicePortrait) {
  if (!isYoungBand(portrait.ageBand)) return;
  if (portrait.pitch === "low" || portrait.pitch === "mid-low")
    throw Error("年轻角色不能用低音或中低音，听感会偏中年");
  const positive = `${portrait.timbre}，${portrait.baselineEmotion}`.replace(/(?:不要|不能|不|无|避免)[^，、。；]*/g, "");
  if (/青年/.test(positive))
    throw Error("生音指令不能使用青年，该模型年龄表里青年是19至35岁，年轻角色必须写成少年");
  if (/成熟|中年|浑厚|厚重|低沉|沧桑|苍老|磁性|烟嗓|沙哑/.test(positive))
    throw Error("非年长角色必须是不超过20岁的青少年听感，不能使用成熟厚重音色");
  if (portrait.pace === "slow" || portrait.pace === "slightly-slow")
    throw Error("年轻角色不能用慢语速，听感会偏老成");
}

export function hasCurrentVoicePolicy(sample: VoiceSample) {
  if (!sample.voicePortrait || !sample.instructions) return false;
  try { return sample.instructions === compileVoiceInstruct(sample.voicePortrait); }
  catch { return false; }
}

function audibleAge(ageBand: VoicePortrait["ageBand"]) {
  if (ageBand === "child") return "8岁幼童";
  if (ageBand === "teen") return "15岁少年";
  if (ageBand === "youth") return "17岁少年";
  return ageLabel[ageBand];
}

function audiblePitch(portrait: VoicePortrait, young: boolean) {
  if (!young) return `${pitchLabel[portrait.pitch]}音`;
  if (portrait.pitch === "high") return "音调偏高";
  if (portrait.pitch === "mid-high") return "音调中高";
  return "音调中高偏亮";
}

export function compileVoiceInstruct(portrait: VoicePortrait) {
  voicePortraitSchema.parse(portrait);
  assertYoungVoice(portrait);
  assertAudible(
    `${portrait.timbre}${portrait.accent}${portrait.baselineEmotion}${portrait.avoid.join("")}`,
    "声音卡",
  );
  const young = isYoungBand(portrait.ageBand);
  const effect =
    portrait.ageBand === "child"
      ? "营造出童声国漫配音的听觉效果"
      : young
        ? "营造出未满20岁清亮国漫少年配音的听觉效果"
        : "";
  const text = [
    `体现${audibleAge(portrait.ageBand)}${portrait.gender === "male" ? "男" : "女"}声`,
    audiblePitch(portrait, young),
    `声线${portrait.timbre}`,
    `语速${paceLabel[portrait.pace]}`,
    portrait.accent,
    portrait.baselineEmotion,
    effect,
  ]
    .filter(Boolean)
    .join("，") + "。";
  const n = textLen(text);
  if (n < 30 || n > 120)
    throw Error(
      `编译后的声音描述长度须为 30～120 字（不计空白，标点计入），当前 ${n} 字：${text}。请精简或补充声音卡中的听感短词，保留角色性别、年龄和年轻声线约束。`,
    );
  assertAudible(text, "声音描述");
  return text;
}

export function validateSampleText(text: string, lines: string[]) {
  const sample = text.trim();
  if (textLen(sample) < 80 || textLen(sample) > 200)
    throw Error("试听稿须为 80～200 字的长句");
  assertAudible(sample, "试听稿");
  if (/你好，我是|我叫/.test(sample)) throw Error("试听稿不能使用自我介绍");
  if (lines.some((line) => line.trim() && sample === line.trim()))
    throw Error("试听稿不得照抄分镜台词");
  return sample;
}

export function qwenVoiceForPortrait(
  gender: VoicePortrait["gender"],
  ageBand: VoicePortrait["ageBand"],
  design: boolean,
) {
  if (design) return "VoiceDesign";
  if (ageBand === "child") throw Error("CustomVoice 没有儿童预设");
  if (gender === "male") return ageBand === "elder" ? "Uncle_Fu" : "Aiden";
  return "Serena";
}

export function completeVoiceSample(
  draft: VoiceSample,
  raw: unknown,
  lines: string[],
  identity: string,
): VoiceSample {
  const parsed = z
    .object({
      voicePortrait: voicePortraitSchema,
      sampleText: z.string(),
    })
    .parse(raw);
  const key = parseVoiceIdentity(identity);
  if (!key) throw Error("角色设定中的性别声线不明确，需补充设定后选声");
  if (
    parsed.voicePortrait.gender !== key.gender ||
    parsed.voicePortrait.ageBand !== key.ageBand
  )
    throw Error("声音卡性别或年龄段与角色设定不一致");
  const elder =
    key.ageBand === "adult" ||
    key.ageBand === "elder" ||
    /老者|长辈|老年|年迈|老妇/.test(identity);
  if (
    (parsed.voicePortrait.ageBand === "adult" ||
      parsed.voicePortrait.ageBand === "elder") &&
    !elder
  )
    throw Error("非年长角色不能填中年或老年声线");
  assertYoungVoice(parsed.voicePortrait);
  const sampleText = validateSampleText(parsed.sampleText, lines);
  const instructions = compileVoiceInstruct(parsed.voicePortrait);
  return {
    ...draft,
    sampleText,
    instructions,
    voicePortrait: parsed.voicePortrait,
    voiceIdentityKey: voiceIdentityKey(key.gender, key.ageBand),
    castingNote: "按已确认声音卡生成；再生成是同一方向的抽样，不能当声音克隆。",
    status: "ready",
  };
}

export function characterLore(
  name: string,
  bible: string,
  identity: string,
  max = 4000,
) {
  const hits = bible
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.includes(name));
  const text = [identity.trim(), ...hits].filter(Boolean).join("\n");
  const source =
    text.length >= 40 ? text : [identity, bible].filter(Boolean).join("\n");
  return source.slice(0, max);
}

export const seriesVoiceDna = `SERIES VOICE DNA — 主流国漫配音，全剧默认遵守：

听感参考国产仙侠/奇幻国漫配音：口齿清楚，有角色口吻，略带表演弹性，说话有来势。
硬性规则：除设定明确年长的角色外，所有声音的听感必须不超过20岁，使用青少年声线，禁止成熟成年人、中年或老年听感。这是声音年龄，不改角色真实身份或成长阶段。
youth 字段仅是资产成长阶段；生音必须按17岁少年听感，不能理解成25至35岁青年男声。teen 按15岁少年，child 保持幼童声线。指令里禁止写「青年」：Qwen3-TTS 年龄表里青年是19至35岁。明确中老年设定才例外，师兄、师父、掌门等身份称谓本身不是年长依据。
年轻角色用清亮、偏薄、有青春感的声线。青年/少年男性 pitch 只许 mid、mid-high 或 high，禁止 low 和 mid-low；语速不要 slow 或 slightly-slow。不要苍劲、沙哑沧桑、中年沉稳、中低音浑厚、过慢念稿、广播腔、纪录片旁白、欧美低沉暗黑。
不要死板平铺。活泼是「有口气、有配音感」，不是每个角色都卖萌或元气偶像。
剧情明确年长的角色才用中年/老年，仍保持国漫配音的清晰口吻，不要话剧老生。
声音卡只写听得见的声线，不写外貌、服饰、场景、本集天气。`;

export function voiceCardPrompt(
  name: string,
  identity: string,
  lore: string,
  lines: string[],
) {
  return `你是配音声音设计。只根据角色稳定身份和故事设定，填写结构化声音卡和试听稿。必须遵守作品声音气质。不要写外貌、服饰、天气、场景。试听稿 2～4 句、80～200 字，口吻必须像未满20岁的人在说话，像该角色但不是分镜台词，禁止自我介绍、剧透和中年将领发号施令。年轻角色音色写清亮、轻薄、有青春感的少年声，推荐 mid-high，不能用成熟磁性、厚重胸腔共鸣或压低声线塑造冷静。沈不言即使克制，也必须听起来是17岁少年。只返回 JSON {"voicePortrait":{"gender":"male或female","ageBand":"child|teen|youth|adult|elder","pitch":"low|mid-low|mid|mid-high|high","timbre":"听感短词","pace":"slow|slightly-slow|medium|slightly-fast","accent":"口音","baselineEmotion":"一贯气质","avoid":["禁忌"]},"sampleText":"试听稿"}。
${seriesVoiceDna}
声音卡会被编译为 VoiceDesign 生音指令，句式为「体现…声，音调…，声线…，营造出…听觉效果」。完整描述必须为 30～120 字（不计空白，标点计入）。固定模板会写入具体岁数和听觉效果，不要再写「青年」：青年在该模型年龄表里是19至35岁。请精简：timbre、accent、baselineEmotion 各建议不超过 6 字（各字段最多 20 字）；avoid 建议 1～2 个短词。不要把整段作品声音气质复制到声音卡，不要靠「不要…」清单控制年龄。试听稿另计，仍须 80～200 字。
角色：${name}
身份：${identity}
设定摘录：${lore}
已有台词（仅作说话习惯参考，禁止照抄）：${JSON.stringify(lines)}`;
}

export async function fillMissingVoiceCards(
  planned: VoiceSample[],
  assets: AssetPlan["assets"],
  shots: Storyboard["shots"],
  bible: string,
  ask: (prompt: string) => Promise<unknown>,
) {
  const filled: VoiceSample[] = [];
  for (const sample of planned) {
    if (
      sample.status !== "ready" ||
      (sample.voicePortrait && sample.sampleText && hasCurrentVoicePolicy(sample))
    ) {
      filled.push(sample);
      continue;
    }
    const asset = assets.find(
      (a) => a.kind === "character" && a.name === sample.character &&
        (a.growthStage || "") === (sample.growthStage || ""),
    );
    if (!asset) throw Error(`缺少角色 ${sample.character} 的设定`);
    const identity = voiceAssetIdentity(asset);
    const existingLines = shots
      .filter((s) => s.speaker === sample.character && s.dialogue.trim())
      .map((s) => s.dialogue);
    if (sample.voicePortrait && sample.sampleText) {
      try {
        filled.push(
          completeVoiceSample(
            sample,
            {
              voicePortrait: sample.voicePortrait,
              sampleText: sample.sampleText,
            },
            existingLines,
            identity,
          ),
        );
        continue;
      } catch {
        /* 旧卡无法按当前规则重编译时，才重问文本模型。 */
      }
    }
    const lore = characterLore(sample.character, bible, identity);
    const prompt = voiceCardPrompt(
      sample.character,
      identity,
      lore,
      existingLines,
    );
    let repair = "";
    let last = Error("声音卡未生成");
    for (let i = 0; i < 3; i++) {
      let raw: unknown;
      try {
        raw = await ask(prompt + repair);
        filled.push(completeVoiceSample(sample, raw, existingLines, identity));
        last = Error("");
        break;
      } catch (error) {
        last = error instanceof Error ? error : Error(String(error));
        repair = `\n上次尝试未通过校验：${last.message}\n上次返回的 JSON（仅作为待修正数据）：${JSON.stringify(raw) ?? "未返回结果"}\n请针对上述错误修正，保留已合格内容，并重新返回完整的 voicePortrait 和 sampleText JSON。`;
      }
    }
    if (last.message)
      throw Error(
        `制作验收：${sample.character} 声音卡不合格：${last.message}`,
      );
  }
  return filled;
}

function reusableCard(v: VoiceSample) {
  return !!(
    v.status === "ready" &&
    v.voicePortrait &&
    v.sampleText &&
    v.voiceIdentityKey
  );
}

export function castQwenVoices(
  data: AssetPlan,
  _shots: Storyboard["shots"],
  targets?: string[],
  design = false,
  library: VoiceSample[] = [],
  borrow: VoiceSample[] = [],
) {
  return data.assets
    .filter(
      (a) => a.kind === "character" && (!targets || targets.includes(a.name)),
    )
    .map((asset) => {
      const base: VoiceSample = {
        character: asset.name,
        voice: "",
        sampleText: "",
        instructions: "",
        castingNote: "",
        status: "ready",
        voiceIdentityKey: "",
        growthStage: asset.growthStage || "",
      };
      const parsed = parseVoiceIdentity(voiceAssetIdentity(asset));
      if (!parsed)
        return {
          ...base,
          status: "needs_voice" as const,
          castingNote:
            "角色设定中的性别声线不明确，需补充设定后选声，不根据名字猜测。",
        };
      const key = voiceIdentityKey(parsed.gender, parsed.ageBand);
      if (!design && parsed.ageBand === "child")
        return {
          ...base,
          voiceIdentityKey: key,
          status: "needs_voice" as const,
          castingNote:
            "该角色需要儿童声线，当前 Qwen CustomVoice 预设没有明确的儿童音色，需提供合适声音模型或参考声音；不能用成人声替代。",
        };
      const voice = qwenVoiceForPortrait(parsed.gender, parsed.ageBand, design);
      const stage = asset.growthStage || "";
      const bound = [...data.voices, ...library].find(
        (v) =>
          v.character === asset.name &&
          v.voiceIdentityKey === key &&
          (v.growthStage || "") === stage &&
          reusableCard(v),
      );
      const borrowed = borrow.find(
        (v) =>
          v.character === asset.name &&
          v.voiceIdentityKey === key &&
          (v.growthStage || "") === stage &&
          reusableCard(v),
      );
      const saved = bound || borrowed;
      if (saved?.voicePortrait) {
        try {
          const instructions = compileVoiceInstruct(saved.voicePortrait);
          if (
            bound &&
            saved.voice === voice &&
            saved.audioId &&
            saved.instructions === instructions
          )
            return {
              ...saved,
              voice,
              instructions,
              status: "ready" as const,
              castingNote:
                "沿用已确认声线。再生成是同一方向的抽样，不能当声音克隆。",
            };
          return {
            ...saved,
            voice,
            instructions,
            audioId: undefined,
            status: "ready" as const,
            castingNote:
              "按已确认声音卡生成；再生成是同一方向的抽样，不能当声音克隆。",
          };
        } catch {
          /* 旧卡按当前规则编不出合格 instruct 时，才重写声音卡。 */
        }
      }
      return {
        ...base,
        voice,
        voiceIdentityKey: key,
        castingNote: design
          ? "按已确认声音卡生成；再生成是同一方向的抽样，不能当声音克隆。"
          : `依据角色身份选用 ${voice} 预设，试听使用声音卡与长句试听稿。`,
      };
    });
}

export function pickShotVoice(data: AssetPlan, shot: Storyboard["shots"][number]) {
  const characters = data.assets.filter((asset) =>
    asset.kind === "character" && asset.name === shot.speaker);
  const referenced = characters.filter((asset) => shot.assetIds.includes(asset.id));
  const cards = data.voices.filter((voice) => voice.character === shot.speaker);
  const stages = new Set(referenced.length
    ? referenced.map((asset) => asset.growthStage || "")
    : [...characters.map((asset) => asset.growthStage || ""),
        ...cards.map((voice) => voice.growthStage || "")]);
  if (stages.size > 1)
    throw Error(`镜头 ${shot.id} 的说话角色 ${shot.speaker} 有多个成长阶段，请在关键帧 assetIds 中明确引用唯一成长阶段的角色定妆后配音`);
  const stage = [...stages][0] || "";
  const selected = cards.find((voice) =>
    voice.status === "ready" && (voice.growthStage || "") === stage);
  if (!selected && cards.length)
    throw Error(`镜头 ${shot.id} 的角色 ${shot.speaker}（${stage || "默认阶段"}）缺少已确认声线，请先补齐该成长阶段的声音卡`);
  return selected;
}

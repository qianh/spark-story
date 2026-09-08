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
  const isMale = /男性|成年男子|青年男子|男人|男子|男孩|少年|老者/.test(text);
  const isFemale = /女性|成年女子|青年女子|女人|女孩|少女|老妇|幼女/.test(text);
  if (isMale === isFemale) return null;
  const gender = isMale ? ("male" as const) : ("female" as const);
  let ageBand: VoicePortrait["ageBand"] | null = null;
  if (
    !/成年|青年|老年/.test(text) &&
    /幼女|幼童|幼儿|婴儿|儿童|小女孩|小男孩/.test(text)
  )
    ageBand = "child";
  else if (/老年|年迈|老者|老妇/.test(text)) ageBand = "elder";
  else if (/青年/.test(text)) ageBand = "youth";
  else if (/少年|少女/.test(text)) ageBand = "teen";
  else if (/中年|成年/.test(text)) ageBand = "adult";
  if (!ageBand) return null;
  return { gender, ageBand };
}

function assertAudible(text: string, label: string) {
  if (visual.test(text)) throw Error(`${label}含画面词，不能用于声音描述`);
}

export function compileVoiceInstruct(portrait: VoicePortrait) {
  voicePortraitSchema.parse(portrait);
  assertAudible(
    `${portrait.timbre}${portrait.accent}${portrait.baselineEmotion}${portrait.avoid.join("")}`,
    "声音卡",
  );
  const text = `${ageLabel[portrait.ageBand]}${portrait.gender === "male" ? "男性" : "女性"}，${pitchLabel[portrait.pitch]}音，音色${portrait.timbre}。语速${paceLabel[portrait.pace]}，吐字清楚。${portrait.accent}。情绪底色${portrait.baselineEmotion}。不要${portrait.avoid.join("、")}。`;
  const n = textLen(text);
  if (n < 30 || n > 120) throw Error("编译后的声音描述长度须为 30～120 字");
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

export function voiceCardPrompt(
  name: string,
  identity: string,
  lore: string,
  lines: string[],
) {
  return `你是配音声音设计。只根据角色稳定身份和故事设定，填写结构化声音卡和试听稿。不要写外貌、服饰、天气、场景。试听稿 2～4 句、80～200 字，口吻像该角色但不是分镜台词，禁止自我介绍和剧透。只返回 JSON {"voicePortrait":{"gender":"male或female","ageBand":"child|teen|youth|adult|elder","pitch":"low|mid-low|mid|mid-high|high","timbre":"听感短词","pace":"slow|slightly-slow|medium|slightly-fast","accent":"口音","baselineEmotion":"一贯气质","avoid":["禁忌"]},"sampleText":"试听稿"}。\n角色：${name}\n身份：${identity}\n设定摘录：${lore}\n本集已确认台词（仅作说话习惯参考，禁止照抄）：${JSON.stringify(lines)}`;
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
      (sample.voicePortrait && sample.sampleText && sample.instructions)
    ) {
      filled.push(sample);
      continue;
    }
    const asset = assets.find((a) => a.name === sample.character);
    if (!asset) throw Error(`缺少角色 ${sample.character} 的设定`);
    const lines = shots
      .filter((s) => s.speaker === sample.character && s.dialogue.trim())
      .map((s) => s.dialogue);
    const lore = characterLore(sample.character, bible, asset.identity);
    let last = Error("声音卡未生成");
    for (let i = 0; i < 3; i++) {
      try {
        filled.push(
          completeVoiceSample(
            sample,
            await ask(
              voiceCardPrompt(sample.character, asset.identity, lore, lines),
            ),
            lines,
            asset.identity,
          ),
        );
        last = Error("");
        break;
      } catch (error) {
        last = error instanceof Error ? error : Error(String(error));
      }
    }
    if (last.message)
      throw Error(
        `制作验收：${sample.character} 声音卡不合格：${last.message}`,
      );
  }
  return filled;
}

function completeCard(v: VoiceSample) {
  return !!(
    v.status === "ready" &&
    v.voicePortrait &&
    v.sampleText &&
    v.instructions &&
    v.voiceIdentityKey
  );
}

export function castQwenVoices(
  data: AssetPlan,
  shots: Storyboard["shots"],
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
      const lines = shots
        .filter((s) => s.speaker === asset.name && s.dialogue.trim())
        .map((s) => s.dialogue);
      const base: VoiceSample = {
        character: asset.name,
        voice: "",
        sampleText: "",
        instructions: "",
        castingNote: "",
        status: "ready",
        voiceIdentityKey: "",
      };
      if (!lines.length)
        return {
          ...base,
          status: "not_required" as const,
          castingNote:
            "本集已确认文字分镜无此角色台词，不生成说话试听；呼吸等非语言声音按分镜音效处理。",
        };
      const parsed = parseVoiceIdentity(asset.identity);
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
      const bound = [...data.voices, ...library].find(
        (v) =>
          v.character === asset.name &&
          v.voiceIdentityKey === key &&
          completeCard(v),
      );
      const borrowed = borrow.find(
        (v) =>
          v.character === asset.name &&
          v.voiceIdentityKey === key &&
          completeCard(v),
      );
      const saved = bound || borrowed;
      if (saved?.voicePortrait) {
        if (bound && saved.voice === voice && saved.audioId)
          return {
            ...saved,
            voice,
            status: "ready" as const,
            castingNote:
              "沿用已确认声线。再生成是同一方向的抽样，不能当声音克隆。",
          };
        return {
          ...saved,
          voice,
          instructions: compileVoiceInstruct(saved.voicePortrait),
          audioId: undefined,
          status: "ready" as const,
          castingNote:
            "按已确认声音卡生成；再生成是同一方向的抽样，不能当声音克隆。",
        };
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

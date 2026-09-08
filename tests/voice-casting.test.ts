import { test, expect } from "bun:test";
import { assetPlanSchema, storyboardSchema } from "../packages/media";
import {
  parseVoiceIdentity,
  voiceIdentityKey,
  compileVoiceInstruct,
  validateSampleText,
  completeVoiceSample,
  castQwenVoices,
  fillMissingVoiceCards,
  characterLore,
  voiceCardPrompt,
} from "../apps/server/voice-casting";

const shen = {
  gender: "male" as const,
  ageBand: "youth" as const,
  pitch: "mid-low" as const,
  timbre: "清冷、偏薄、不浑厚",
  pace: "slightly-slow" as const,
  accent: "标准普通话，无方言",
  baselineEmotion: "克制、冷、不煽情",
  avoid: ["广告腔", "卖萌", "朗诵", "读画面"],
};
const audition =
  "我只问她还活着没有。先把人带离石阶，再谈其余。剑还在腰侧，这一夜不许任何人靠近。青梧的规矩不是拿来吓孩子的，是拿来护人的。山门空着，谁来都要先过我这一关，没有例外。";

test("从稳定身份解析声线键，画面状态不影响", () => {
  expect(parseVoiceIdentity("男性，青年剑修。")).toEqual({
    gender: "male",
    ageBand: "youth",
  });
  expect(
    parseVoiceIdentity(
      "青梧宗青年剑修沈不言。男性，成年而未显老。外袍被秋雨湿透。",
    ),
  ).toEqual({ gender: "male", ageBand: "youth" });
  expect(voiceIdentityKey("male", "youth")).toBe("male:youth");
  expect(parseVoiceIdentity("幼女，尚不能说话")).toEqual({
    gender: "female",
    ageBand: "child",
  });
  expect(parseVoiceIdentity("老年男子")).toEqual({
    gender: "male",
    ageBand: "elder",
  });
  expect(parseVoiceIdentity("沈不言")).toBeNull();
});

test("编译 instruct 只用听感，拒绝把湿袍写进声音", () => {
  const text = compileVoiceInstruct(shen);
  expect(text).toContain("青年男性");
  expect(text).toContain("中低音");
  expect(text).toContain("清冷、偏薄、不浑厚");
  expect(text).not.toMatch(/袍|骨|雨|叶|皮肤/);
  expect([...text].length).toBeGreaterThanOrEqual(30);
  expect([...text].length).toBeLessThanOrEqual(120);
  expect(() =>
    compileVoiceInstruct({ ...shen, timbre: "湿袍贴身的冷白皮肤" }),
  ).toThrow("画面");
});

test("试听稿必须是长句且不得照抄分镜台词", () => {
  expect(() => validateSampleText("还活着。", ["还活着。"])).toThrow("80");
  expect(() => validateSampleText(audition, [audition])).toThrow("照抄");
  expect(validateSampleText(audition, ["还活着。", "先走。"])).toBe(audition);
});

test("文本模型返回的声音卡与设定打架或含画面词时拒绝", () => {
  const draft = {
    character: "沈不言",
    voice: "VoiceDesign",
    sampleText: "",
    instructions: "",
    castingNote: "",
    status: "ready" as const,
    voiceIdentityKey: "male:youth",
  };
  expect(() =>
    completeVoiceSample(
      draft,
      {
        voicePortrait: { ...shen, gender: "female" },
        sampleText: audition,
      },
      ["还活着。"],
      "男性，青年剑修。",
    ),
  ).toThrow("不一致");
  expect(() =>
    completeVoiceSample(
      draft,
      {
        voicePortrait: { ...shen, timbre: "青黑外袍与金叶" },
        sampleText: audition,
      },
      ["还活着。"],
      "男性，青年剑修。",
    ),
  ).toThrow("画面");
  const done = completeVoiceSample(
    draft,
    { voicePortrait: shen, sampleText: audition },
    ["还活着。"],
    "男性，青年剑修。",
  );
  expect(done.sampleText).toBe(audition);
  expect(done.instructions).toContain("青年男性");
  expect(done.instructions).not.toContain("还活着");
  expect(done.voicePortrait).toEqual(shen);
  expect(() =>
    completeVoiceSample(
      draft,
      {
        voicePortrait: { ...shen, ageBand: "adult" },
        sampleText: audition,
      },
      ["还活着。"],
      "男性，青年剑修。",
    ),
  ).toThrow("不一致");
});

test("无台词幼女不配音；CustomVoice 幼童待选型；VoiceDesign 可写卡", () => {
  const data = assetPlanSchema.parse({
    summary: "",
    assets: [
      {
        id: "a",
        name: "沈不言",
        kind: "character",
        prompt: "剑修",
        identity: "男性，青年剑修。",
        state: "怀抱幼女，外袍湿透",
      },
      {
        id: "b",
        name: "病弱幼女",
        kind: "character",
        prompt: "幼女",
        identity: "幼女，尚不能说话",
      },
    ],
    voices: [
      {
        character: "沈不言",
        voice: "Vivian",
        sampleText: "错误自我介绍",
        audioId: "wrong",
      },
    ],
  });
  const shots = storyboardSchema.parse({
    summary: "",
    shots: [
      {
        id: "1",
        title: "救人",
        prompt: "救人",
        duration: 1,
        speaker: "沈不言",
        dialogue: "还活着。",
      },
    ],
  }).shots;
  const [male, child] = castQwenVoices(data, shots);
  expect(male.voice).toBe("Aiden");
  expect(male.sampleText).toBe("");
  expect(male.instructions).toBe("");
  expect(male.voiceIdentityKey).toBe("male:youth");
  expect(male).not.toHaveProperty("audioId");
  expect(child.status).toBe("not_required");
  const speaking = castQwenVoices(data, [
    { ...shots[0], speaker: "病弱幼女", dialogue: "别走。" },
  ]);
  expect(speaking[1].status).toBe("needs_voice");
  const designed = castQwenVoices(
    data,
    [{ ...shots[0], speaker: "病弱幼女", dialogue: "别走。" }],
    undefined,
    true,
  );
  expect(designed[1].voice).toBe("VoiceDesign");
  expect(designed[1].status).toBe("ready");
  expect(designed[1].voiceIdentityKey).toBe("female:child");
  expect(designed[1].instructions).toBe("");
});

test("声线键相同则整份复用已绑定声音卡，年龄段变了才作废", () => {
  const data = assetPlanSchema.parse({
    summary: "",
    assets: [
      {
        id: "a",
        name: "沈不言",
        kind: "character",
        prompt: "剑修",
        identity: "男性，青年剑修。",
        state: "第十年金叶已落",
      },
    ],
    voices: [],
  });
  const shots = storyboardSchema.parse({
    summary: "",
    shots: [
      {
        id: "1",
        title: "问",
        prompt: "问",
        duration: 1,
        speaker: "沈不言",
        dialogue: "先走。",
      },
    ],
  }).shots;
  const saved = {
    character: "沈不言",
    voice: "VoiceDesign",
    sampleText: audition,
    instructions: compileVoiceInstruct(shen),
    castingNote: "沿用",
    status: "ready" as const,
    audioId: "old-audio",
    voicePortrait: shen,
    voiceIdentityKey: "male:youth",
  };
  const reused = castQwenVoices(data, shots, undefined, true, [saved]);
  expect(reused[0].audioId).toBe("old-audio");
  expect(reused[0].sampleText).toBe(audition);
  expect(reused[0].instructions).toBe(saved.instructions);
  expect(reused[0].castingNote).toContain("沿用已确认声线");
  const aged = assetPlanSchema.parse({
    ...data,
    assets: [
      {
        ...data.assets[0],
        identity: "男性，老年剑修。",
      },
    ],
  });
  const next = castQwenVoices(aged, shots, undefined, true, [saved]);
  expect(next[0].audioId).toBeUndefined();
  expect(next[0].sampleText).toBe("");
  expect(next[0].voiceIdentityKey).toBe("male:elder");
  const switched = castQwenVoices(data, shots, undefined, true, [], [saved]);
  expect(switched[0].sampleText).toBe(audition);
  expect(switched[0].audioId).toBeUndefined();
});

test("未完成的声音卡向文本模型要结构化卡和试听稿，不合格最多三次", async () => {
  const data = assetPlanSchema.parse({
    summary: "",
    assets: [
      {
        id: "a",
        name: "沈不言",
        kind: "character",
        prompt: "剑修",
        identity: "男性，青年剑修。",
      },
    ],
    voices: [],
  });
  const shots = storyboardSchema.parse({
    summary: "",
    shots: [
      {
        id: "1",
        title: "问",
        prompt: "问",
        duration: 1,
        speaker: "沈不言",
        dialogue: "还活着。",
      },
    ],
  }).shots;
  const planned = castQwenVoices(data, shots, undefined, true);
  let calls = 0;
  const filled = await fillMissingVoiceCards(
    planned,
    data.assets,
    shots,
    "沈不言是青梧宗青年剑修，话少、护人。",
    async (prompt) => {
      calls++;
      expect(prompt).toContain("沈不言");
      expect(prompt).not.toContain("怀抱");
      if (calls < 2) return { voicePortrait: shen, sampleText: "还活着。" };
      return { voicePortrait: shen, sampleText: audition };
    },
  );
  expect(calls).toBe(2);
  expect(filled[0].sampleText).toBe(audition);
  expect(filled[0].instructions).toContain("青年男性");
  expect(
    characterLore("沈不言", "旁人。\n沈不言护山。\n无关。", "青年男性"),
  ).toContain("沈不言护山");
  expect(
    voiceCardPrompt("沈不言", "男性，青年剑修。", "摘录", ["还活着。"]),
  ).toContain("禁止照抄");
  expect(
    voiceCardPrompt("沈不言", "男性，青年剑修。", "摘录", ["还活着。"]),
  ).toContain("SERIES VOICE DNA");
});

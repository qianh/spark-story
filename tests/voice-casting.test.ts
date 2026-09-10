import { test, expect } from "bun:test";
import { assetPlanSchema, storyboardSchema, voiceSampleSchema } from "../packages/media";
import {
  parseVoiceIdentity,
  hasCurrentVoicePolicy,
  voiceIdentityKey,
  compileVoiceInstruct,
  validateSampleText,
  completeVoiceSample,
  castQwenVoices,
  fillMissingVoiceCards,
  characterLore,
  voiceCardPrompt,
  pickShotVoice,
} from "../apps/server/voice-casting";

const shen = {
  gender: "male" as const,
  ageBand: "youth" as const,
  pitch: "mid" as const,
  timbre: "清冷、偏薄、不浑厚",
  pace: "medium" as const,
  accent: "标准普通话，无方言",
  baselineEmotion: "克制、冷、不煽情",
  avoid: ["广告腔", "卖萌", "朗诵", "读画面"],
};
const audition =
  "我只问她还活着没有。先把人带离石阶，再谈其余。剑还在腰侧，这一夜不许任何人靠近。青梧的规矩不是拿来吓孩子的，是拿来护人的。山门空着，谁来都要先过我这一关，没有例外。";

test("声音卡提示禁止青年用中低音", () => {
  const prompt = voiceCardPrompt("沈不言", "男性，青年剑修。", "护山。", []);
  expect(prompt).toContain("mid、mid-high 或 high");
  expect(prompt).toContain("禁止 low 和 mid-low");
  expect(prompt).toContain("青春感");
  expect(prompt).toContain("完整描述必须为 30～120 字");
  expect(prompt).toContain("试听稿另计，仍须 80～200 字");
});

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
  expect(text).toContain("体现17岁少年男声");
  expect(text).toContain("音调中高偏亮");
  expect(text).toContain("清冷、偏薄、不浑厚");
  expect(text).toContain("营造出未满20岁清亮国漫少年配音的听觉效果");
  expect(text).not.toContain("青年");
  expect(text).not.toMatch(/不要/);
  expect(text).not.toMatch(/袍|骨|雨|叶|皮肤/);
  expect([...text].length).toBeGreaterThanOrEqual(30);
  expect([...text].length).toBeLessThanOrEqual(120);
  expect(() =>
    compileVoiceInstruct({ ...shen, timbre: "湿袍贴身的冷白皮肤" }),
  ).toThrow("画面");
});

test("年轻角色拒绝中低音和慢语速，避免听成中年", () => {
  expect(() => compileVoiceInstruct({ ...shen, pitch: "mid-low" })).toThrow(
    "中低音",
  );
  expect(() => compileVoiceInstruct({ ...shen, pitch: "low" })).toThrow("低音");
  expect(() => compileVoiceInstruct({ ...shen, pace: "slow" })).toThrow(
    "慢语速",
  );
  expect(() =>
    compileVoiceInstruct({ ...shen, pace: "slightly-slow" }),
  ).toThrow("慢语速");
  expect(
    compileVoiceInstruct({
      ...shen,
      ageBand: "elder",
      pitch: "mid-low",
      pace: "slow",
    }),
  ).toContain("体现老年男声");
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
  expect(done.instructions).toContain("体现17岁少年男声");
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
  expect(() =>
    completeVoiceSample(
      draft,
      {
        voicePortrait: { ...shen, pitch: "mid-low" },
        sampleText: audition,
      },
      ["还活着。"],
      "男性，青年剑修。",
    ),
  ).toThrow("中低音");
});

test("全剧角色不依赖单集台词；CustomVoice 幼童待选型；VoiceDesign 可写卡", () => {
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
  expect(child.status).toBe("needs_voice");
  expect(castQwenVoices(data, [], undefined, true).map((v) => v.status)).toEqual(["ready", "ready"]);
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
  const stale = castQwenVoices(data, shots, undefined, true, [
    { ...saved, instructions: "青年男性，偏年轻、有青春感。" },
  ]);
  expect(stale[0].voicePortrait).toEqual(shen);
  expect(stale[0].sampleText).toBe(audition);
  expect(stale[0].instructions).toBe(compileVoiceInstruct(shen));
  expect(stale[0].audioId).toBeUndefined();
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
      expect(prompt).toContain("上次尝试未通过校验：试听稿须为 80～200 字");
      expect(prompt).toContain('"sampleText":"还活着。"');
      return { voicePortrait: shen, sampleText: audition };
    },
  );
  expect(calls).toBe(2);
  expect(filled[0].sampleText).toBe(audition);
  expect(filled[0].instructions).toContain("体现17岁少年男声");
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

test("禁忌清单不进入生音指令；不合格声音卡仍最多修三次", async () => {
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
  const bloated = {
    ...shen,
    avoid: [...shen.avoid, "不要使用过度夸张的舞台表演语气".repeat(5)],
  };
  expect(compileVoiceInstruct(bloated)).not.toMatch(/不要/);
  expect([...compileVoiceInstruct(bloated)].length).toBeLessThanOrEqual(120);
  const bad = { voicePortrait: { ...shen, timbre: "青年男声" }, sampleText: audition };
  let calls = 0;
  const result = await fillMissingVoiceCards(
    planned,
    data.assets,
    shots,
    "护山。",
    async (prompt) => {
      calls++;
      if (calls === 1) return bad;
      expect(prompt).toContain("青年");
      expect(prompt).toContain(JSON.stringify(bad));
      expect(prompt).toContain(
        "重新返回完整的 voicePortrait 和 sampleText JSON",
      );
      return { voicePortrait: shen, sampleText: audition };
    },
  );
  expect(calls).toBe(2);
  expect(result[0].instructions).toBe(compileVoiceInstruct(shen));
  expect(result[0].sampleText).toBe(audition);

  calls = 0;
  await expect(
    fillMissingVoiceCards(planned, data.assets, shots, "护山。", async () => {
      calls++;
      return bad;
    }),
  ).rejects.toThrow("沈不言 声音卡不合格：生音指令不能使用青年");
  expect(calls).toBe(3);
});


test("全剧同名角色各成长阶段独立生成声音卡，不借用其他阶段", async () => {
  const data = assetPlanSchema.parse({ summary: "", voices: [], assets: [
    { id: "teen", kind: "character", name: "沈不言", growthStage: "少年期", identity: "男性，少年剑修。", prompt: "剑修" },
    { id: "youth", kind: "character", name: "沈不言", growthStage: "青年期", identity: "男性，青年剑修。", prompt: "剑修" },
  ] });
  const planned = castQwenVoices(data, [], undefined, true);
  expect(planned.map((v) => v.growthStage)).toEqual(["少年期", "青年期"]);
  const filled = await fillMissingVoiceCards(planned, data.assets, [], "沈不言成长为护山剑修。", async (prompt) => ({
    voicePortrait: { ...shen, ageBand: prompt.includes("身份：男性，少年剑修") ? "teen" : "youth" },
    sampleText: audition,
  }));
  expect(filled.map((v) => v.voiceIdentityKey)).toEqual(["male:teen", "male:youth"]);
  const wrongStage = { ...filled[1], growthStage: "另一阶段", audioId: "wrong-stage" };
  const borrowed = castQwenVoices(data, [], undefined, true, [], [wrongStage]);
  expect(borrowed[1].sampleText).toBe("");
  expect(borrowed[1].audioId).toBeUndefined();
});


test("镜头按引用定妆的成长阶段选声，歧义或缺失声线不静默回退", () => {
  const data = assetPlanSchema.parse({ summary: "", assets: [
    { id: "young", kind: "character", name: "沈不言", growthStage: "少年期", prompt: "少年" },
    { id: "old", kind: "character", name: "沈不言", growthStage: "老年期", prompt: "老年" },
    { id: "costume", kind: "character", name: "沈不言", growthStage: "少年期", prompt: "少年礼服" },
  ], voices: [
    { character: "沈不言", growthStage: "老年期", voice: "elder", sampleText: "老年试听" },
    { character: "沈不言", growthStage: "少年期", voice: "teen", sampleText: "少年试听" },
  ] });
  const shot = storyboardSchema.parse({ summary: "", shots: [
    { id: "s1", title: "问", prompt: "问", duration: 1, speaker: "沈不言", dialogue: "是谁？", assetIds: ["young"] },
  ] }).shots[0];
  expect(pickShotVoice(data, shot)?.voice).toBe("teen");
  expect(pickShotVoice(data, { ...shot, assetIds: ["old"] })?.voice).toBe("elder");
  expect(pickShotVoice(data, { ...shot, assetIds: ["young", "costume"] })?.voice).toBe("teen");
  expect(() => pickShotVoice(data, { ...shot, assetIds: [] })).toThrow("明确引用唯一成长阶段");
  expect(() => pickShotVoice(data, { ...shot, assetIds: ["young", "old"] })).toThrow("明确引用唯一成长阶段");
  expect(() => pickShotVoice({ ...data, voices: [data.voices[0]] }, shot)).toThrow("少年期");
  expect(pickShotVoice({ ...data, assets: [data.assets[0]], voices: [data.voices[1]] }, { ...shot, assetIds: [] })?.voice).toBe("teen");
});

test("声线读取自身英文 Subject 和成长阶段，名字不用于猜性别", () => {
  const data = assetPlanSchema.parse({ summary: "", voices: [], assets: [{
    id: "shen:youth", name: "沈不言", kind: "character", identity: "青梧宗青年剑修沈不言",
    growthStage: "youth", prompt: "Subject: youth Chinese male xianxia sword cultivator",
  }] });
  expect(castQwenVoices(data, [], undefined, true)[0].voiceIdentityKey).toBe("male:youth");
  data.assets[0].prompt = "Subject: child Chinese female foundling";
  data.assets[0].identity = "幼女";
  data.assets[0].growthStage = "child";
  expect(castQwenVoices(data, [], undefined, true)[0].voiceIdentityKey).toBe("female:child");
  data.assets[0].prompt = "Subject: sword cultivator";
  data.assets[0].identity = "沈不言";
  data.assets[0].growthStage = "youth";
  expect(castQwenVoices(data, [], undefined, true)[0].status).toBe("needs_voice");
});


test("20岁上限进入声音卡提示和实际生音指令，旧青年卡不能继续复用", () => {
  const prompt = voiceCardPrompt("沈不言", "青年男性", "", []);
  expect(prompt).toContain("听感必须不超过20岁");
  expect(prompt).toContain("体现");
  expect(prompt).toContain("听觉效果");
  expect(prompt).toContain("青年在该模型年龄表里是19至35岁");
  expect(prompt).toContain("口吻必须像未满20岁");
  const instructions = compileVoiceInstruct(shen);
  expect(instructions).toContain("体现17岁少年男声");
  expect(instructions).toContain("营造出未满20岁清亮国漫少年配音的听觉效果");
  expect(compileVoiceInstruct({ ...shen, ageBand: "teen" })).toContain("体现15岁少年男声");
  expect(compileVoiceInstruct({ ...shen, ageBand: "child", gender: "female", pitch: "mid-high" })).toContain("体现8岁幼童女声");
  const sample = voiceSampleSchema.parse({character:"沈不言",voice:"VoiceDesign",sampleText:"试听",voicePortrait:shen,instructions});
  expect(hasCurrentVoicePolicy(sample)).toBe(true);
  expect(hasCurrentVoicePolicy({...sample, instructions:"青年男性，偏年轻、有青春感。"})).toBe(false);
  expect(() => compileVoiceInstruct({...shen,timbre:"成熟磁性"})).toThrow("不超过20岁");
  expect(() => compileVoiceInstruct({...shen,timbre:"青年男声"})).toThrow("青年");
  const elder = compileVoiceInstruct({...shen,ageBand:"elder",pitch:"low",pace:"slow",timbre:"沧桑"});
  expect(elder).toContain("体现老年男声");
  expect(elder).not.toContain("未满20岁");
});

test("已有合格声音卡只重编译 instruct，不重问文本模型", async () => {
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
  const planned = [
    {
      character: "沈不言",
      voice: "VoiceDesign",
      sampleText: audition,
      instructions: "青年男性，偏年轻、有青春感。",
      castingNote: "旧指令",
      status: "ready" as const,
      voicePortrait: shen,
      voiceIdentityKey: "male:youth",
    },
  ];
  const filled = await fillMissingVoiceCards(
    planned,
    data.assets,
    [],
    "护山。",
    async () => {
      throw Error("合格声音卡不应重问文本模型");
    },
  );
  expect(filled[0].instructions).toBe(compileVoiceInstruct(shen));
  expect(filled[0].sampleText).toBe(audition);
  expect(filled[0].voicePortrait).toEqual(shen);
});

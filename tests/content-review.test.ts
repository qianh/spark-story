import { expect, test } from "bun:test";
import {
  AssetContentReviewError,
  assetContentFixPrompt,
  assetContentReviewPrompt,
  assetRevisionContext,
  reviewAssetContentWith,
  seriesLookFactsPrompt,
} from "../apps/server/director";
import { lookPipelineErrorStatus, MediaPipeline } from "../apps/server/media-pipeline";
import { Store } from "../apps/server/store";
import type { Runtime } from "../apps/server/runtime";
import type { Connection } from "../packages/domain";

const courtyardScene = `CONTENT — SCENE (fill per location):
Place: 年轮大殿 open courtyard
Enclosure: outdoor open courtyard
Scale: empty yard
Time / weather: overcast day
Near camera: incense table
Mid: open court
Far: whole tree in open air
Materials: stone
Set dressing: none
People: none
Camera: wide establishing`;

const hallScene = `CONTENT — SCENE (fill per location):
Place: 年轮大殿 indoor axial hall
Enclosure: indoor enclosed axial hall, 室内封闭中轴正殿
Scale: hall deep enough for facing seats
Time / weather: clear readable daylight
Near camera: dark timber beams
Mid: facing seats on thick felt
Far: 古梧本根神位 at the enclosed shrine end
Materials: dark timber
Set dressing: none
People: none
Camera: axial indoor view`;

const story = {
  type: "story" as const,
  bible: "青梧宗年轮大殿是正殿。",
  chapters: [
    {
      id: "CH001",
      title: "议事",
      content:
        "年轮大殿是室内中轴正殿，暗木梁架，尽头本根如神位。今日办喜事，梁上挂着红灯笼。议事席分列两侧，席下厚毡。".repeat(2),
      continuity: "议事",
      beats: [{ id: "CH001-B001", eventId: "E001", description: "议事" }],
    },
    {
      id: "CH002",
      title: "山路",
        content: "沈不言走在山路上，未回宗门。林间只有风声，这一段不写正殿。".repeat(2),
      continuity: "山路",
      beats: [{ id: "CH002-B001", eventId: "E002", description: "山路" }],
    },
  ],
  lookRegistry: {
    type: "look-registry" as const,
    entities: [
      {
        id: "scene-dadian",
        name: "年轮大殿",
        kind: "scene" as const,
        variants: [
          {
            id: "default",
            name: "年轮大殿",
            kind: "form" as const,
            identity: "青梧宗室内中轴正殿",
            form: "暗木梁架，尽头本根神位",
            source: "CH001",
          },
        ],
      },
    ],
  },
};

const asset = {
  id: "scene-dadian:default",
  name: "年轮大殿",
  kind: "scene",
  prompt: courtyardScene,
  promptFormat: "scene-content-v1" as const,
  identity: "年轮大殿",
  state: "院子",
};

test("CONTENT 核对提示词从全书筛相关章节，只验收固定形制", () => {
  const ctx = assetRevisionContext(story, story.lookRegistry, asset);
  const prompt = assetContentReviewPrompt(asset, ctx);
  expect(prompt.startsWith("你是定妆 CONTENT 核对。")).toBe(true);
  expect(prompt).toContain("这一条资产单独");
  expect(prompt).toContain("整部剧共用的参考图");
  expect(prompt).toContain("本根");
  expect(prompt).toContain("红灯笼");
  expect(prompt).not.toContain("沈不言走在山路上");
  expect(prompt).toContain(courtyardScene);
  expect(prompt).toContain("不要发明");
  expect(prompt).toContain("不要写入");
  expect(assetContentFixPrompt(asset, ctx, {
    pass: false,
    feedback: "写成了院子，缺本根神位",
    missing: ["本根神位"],
    wrong: ["outdoor courtyard"],
  }).startsWith("你是定妆 CONTENT 补写。")).toBe(true);
});

test("院子 CONTENT 对照正殿章节时先失败再补写通过", async () => {
  const ctx = assetRevisionContext(story, story.lookRegistry, asset);
  const calls: string[] = [];
  const result = await reviewAssetContentWith(
    async (prompt) => {
      calls.push(prompt.startsWith("你是定妆 CONTENT 核对。") ? "review" : "other");
      if (prompt.includes("outdoor open courtyard"))
        return {
          pass: false,
          feedback: "写成了院子，缺室内本根神位",
          missing: ["本根神位"],
          wrong: ["outdoor courtyard"],
        };
      return { pass: true, feedback: "室内正殿与本根神位已写全", missing: [], wrong: [] };
    },
    asset,
    ctx,
    async () => ({ prompt: hallScene, promptFormat: "scene-content-v1" }),
  );
  expect(calls[0]).toBe("review");
  expect(result.prompt).toBe(hallScene);
  expect(result.review.pass).toBe(true);
  expect(result.review.prompt).toBe(hallScene);
});

test("定妆出图前必须 CONTENT 核对通过", async () => {
  const store = new Store(":memory:");
  const project = store.createProject({
    name: "核对",
    source: "年轮大殿",
    inputType: "idea",
    aspect: "16:9",
    template: "cel",
    budget: 0,
  });
  store.patchSettings(project.id, { lookRegistry: story.lookRegistry });
  const storyTask = store.tasks(project.id).find((task) => task.stage === 7)!;
  store.publish(storyTask.id, storyTask.revision, JSON.stringify(story));
  const generated: string[] = [];
  let rewritten = false;
  const pipeline = new MediaPipeline({
    store,
    call: async (_task, _attempt, _connection, prompt: string) => {
      if (prompt.startsWith("你是定妆 CONTENT 核对")) {
        if (prompt.includes("outdoor open courtyard"))
          return JSON.stringify({
            pass: false,
            feedback: "写成了院子，缺本根神位",
            missing: ["本根神位"],
            wrong: ["courtyard"],
          });
        return JSON.stringify({
          pass: true,
          feedback: "室内正殿已写全",
          missing: [],
          wrong: [],
        });
      }
      if (prompt.startsWith("你是定妆 CONTENT 补写")) {
        rewritten = true;
        return JSON.stringify({ prompt: hallScene, promptFormat: "scene-content-v1" });
      }
      throw Error(prompt.slice(0, 40));
    },
    media: {
      files: { get: () => ({ path: "test.png" }) },
      connection: () => ({}),
      ensure: async () => {
        if (!rewritten) throw Error("CONTENT 未核对就出图");
        generated.push("image");
        return "image-1";
      },
    },
  } as unknown as Runtime);
  const task = store.tasks(project.id).find((item) => item.stage === 3)!;
  const result = await pipeline.produce(
    task,
    "attempt",
    {} as Connection,
    [],
    "",
    {
      type: "assets",
      data: {
        summary: "殿",
        assets: [asset],
        voices: [],
      },
    },
    new AbortController().signal,
    undefined,
    true,
  );
  expect(generated).toEqual(["image"]);
  expect((result.data as { assets: { prompt: string }[] }).assets[0].prompt).toContain(
    "indoor enclosed axial hall",
  );
  store.db.close();
});

test("机械核对否决院子后即使模型说通过也要补写", async () => {
  const ctx = assetRevisionContext(story, story.lookRegistry, asset);
  const result = await reviewAssetContentWith(
    async () => ({
      pass: true,
      feedback: "字段齐全",
      missing: [],
      wrong: [],
    }),
    asset,
    ctx,
    async () => ({ prompt: hallScene, promptFormat: "scene-content-v1" }),
  );
  expect(result.prompt).toBe(hallScene);
  expect(result.review.pass).toBe(true);
});

test("全剧定妆事实包含空眼与倒置形制", () => {
  const facts = seriesLookFactsPrompt();
  expect(facts).toContain("空眼写贴面空板");
  expect(facts).toContain("禁止写 mask");
  expect(facts).toContain("倒置炉鼎口朝下");
  expect(facts).toContain("铁尺不是学生尺");
  expect(facts).toContain("默认可读日光");
  expect(facts).toContain("冲不干净");
  expect(facts).toContain("这一条资产单独");
  expect(facts).toContain("不要把同场其他");
  expect(facts).toContain("只许翻译本条登记");
  expect(facts).toContain("只有问道台才写 open terrace");
  expect(facts).toContain("父兄式身量只写宽肩厚背的青年体量");
});

const treeOnlyScene = `CONTENT — SCENE (fill per location):
Place: 通天古梧
Enclosure: outdoor open tree in cloud sea
Scale: human at roots; tree crown unseen, roots unseen
Time / weather: clear readable daylight
Near camera: wutong-grain root bark
Mid: giant trunk with year-rings, gold leaves
Far: crown into cloud sea, no mountain gate
Materials: wutong grain, wet fog, gold leaves
Set dressing: year-rings, gold leaves. no plaque, no gate columns, no stone steps
People: none
Camera: the tree alone`;

const treeWithGateScene = `CONTENT — SCENE (fill per location):
Place: 青梧宗山门通天古梧。山门与树一体
Enclosure: outdoor open courtyard
Scale: human on last step
Time / weather: dry clear
Near camera: 梧桐木纹门柱；门楣牌匾写青梧宗
Mid: 通天巨梧树干自山门升起
Far: 冠没入云海
Materials: wutong grain
Set dressing: 山门石阶、门柱、牌匾
People: none
Camera: gate and tree together`;

const gateAndTreeRegistry = {
  type: "look-registry" as const,
  entities: [
    {
      id: "scene-shanmen",
      name: "青梧宗山门",
      kind: "scene" as const,
      variants: [
        {
          id: "default",
          name: "梧桐木纹山门",
          kind: "form" as const,
          identity: "青梧宗山门。通天古梧所在的山门。",
          form: "梧桐木纹门柱，山门石阶，门楣牌匾写青梧宗",
          source: "CH001",
        },
      ],
    },
    {
      id: "scene-guwu",
      name: "通天古梧",
      kind: "scene" as const,
      variants: [
        {
          id: "default",
          name: "通天古梧",
          kind: "form" as const,
          identity: "青梧宗山门通天古梧。冠看不见顶，根看不见底。",
          form: "通天巨梧，叶脉可渗潮气。根冠入云海。金叶。",
          source: "CH001",
        },
      ],
    },
  ],
};

const treeStory = {
  ...story,
  bible: "山门是通天古梧。",
  chapters: [
    {
      id: "CH001",
      title: "山门秋雨",
      content:
        "通天古梧立在云海深处，冠看不见顶，根看不见底。雨从叶脉里渗下来，砸在山门石阶上。雾贴着梧桐木纹的门柱往上爬。门楣牌匾写着青梧宗。",
      continuity: "入宗",
      beats: [{ id: "CH001-B001", eventId: "E001", description: "入宗" }],
    },
  ],
  lookRegistry: gateAndTreeRegistry,
};

const treeAsset = {
  id: "scene-guwu:default",
  name: "通天古梧",
  kind: "scene",
  prompt: treeWithGateScene,
  promptFormat: "scene-content-v1" as const,
  identity: "青梧宗山门通天古梧。冠看不见顶，根看不见底。",
  state: "通天巨梧",
};

test("通天古梧核对只参考树的句子，并列出不要写入的山门", () => {
  const ctx = assetRevisionContext(treeStory, treeStory.lookRegistry, treeAsset);
  expect(ctx.otherLooks.map((look) => look.name)).toContain("青梧宗山门");
  expect(ctx.chapters[0].excerpt).toContain("冠看不见顶");
  expect(ctx.chapters[0].excerpt).not.toContain("门楣牌匾");
  const prompt = assetContentReviewPrompt(treeAsset, ctx);
  expect(prompt).toContain("青梧宗山门");
  expect(prompt).toContain("不要写入");
  expect(prompt).toContain("只作参考");
});

test("通天古梧写成山门时机械打回，补写只留树", async () => {
  const ctx = assetRevisionContext(treeStory, treeStory.lookRegistry, treeAsset);
  const result = await reviewAssetContentWith(
    async () => ({
      pass: true,
      feedback: "字段齐全，山门与树一体",
      missing: [],
      wrong: [],
    }),
    treeAsset,
    ctx,
    async () => ({ prompt: treeOnlyScene, promptFormat: "scene-content-v1" }),
  );
  expect(result.prompt).toBe(treeOnlyScene);
  expect(result.review.pass).toBe(true);
});

test("核对提示词带上上次未通过原因，供补写按意见改", () => {
  const ctx = assetRevisionContext(story, story.lookRegistry, asset);
  const prompt = assetContentReviewPrompt(asset, ctx, {
    pass: false,
    feedback: "删掉干燥白日光和冲不干净",
    missing: [],
    wrong: ["dry clear", "冲不干净"],
  });
  expect(prompt).toContain("上次未通过");
  expect(prompt).toContain("删掉干燥白日光和冲不干净");
  expect(assetContentFixPrompt(asset, ctx, {
    pass: false,
    feedback: "删掉干燥白日光和冲不干净",
    missing: [],
    wrong: ["dry clear"],
  })).toContain("核对意见");
});

test("核对轮次用尽时抛出带最后一稿的 CONTENT 错误", async () => {
  const ctx = assetRevisionContext(story, story.lookRegistry, asset);
  const rewritten = hallScene.replace("indoor axial hall", "still courtyard");
  try {
    await reviewAssetContentWith(
      async () => ({
        pass: false,
        feedback: "仍是院子",
        missing: ["本根神位"],
        wrong: ["courtyard"],
      }),
      asset,
      ctx,
      async () => ({ prompt: rewritten, promptFormat: "scene-content-v1" }),
      { maxRounds: 1 },
    );
    throw Error("应当抛出核对失败");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetContentReviewError);
    const failed = error as AssetContentReviewError;
    expect(failed.prompt).toBe(rewritten);
    expect(failed.review.feedback).toContain("仍是院子");
    expect(failed.message).toContain("年轮大殿");
  }
});

test("第一轮机械未过的排入下一轮，全部提示词通过后才出图", async () => {
  const store = new Store(":memory:");
  const project = store.createProject({
    name: "分轮",
    source: "古梧与大殿",
    inputType: "idea",
    aspect: "16:9",
    template: "cel",
    budget: 0,
  });
  store.patchSettings(project.id, {
    lookRegistry: {
      type: "look-registry",
      entities: [...story.lookRegistry.entities, ...gateAndTreeRegistry.entities],
    },
  });
  const storyTask = store.tasks(project.id).find((task) => task.stage === 7)!;
  store.publish(
    storyTask.id,
    storyTask.revision,
    JSON.stringify({
      ...treeStory,
      chapters: [...treeStory.chapters, ...story.chapters],
      lookRegistry: store.settings(project.id).lookRegistry,
    }),
  );
  const steps: string[] = [];
  let treeRewrites = 0;
  const pipeline = new MediaPipeline({
    store,
    call: async (_task, _attempt, _connection, prompt: string) => {
      if (prompt.startsWith("你是定妆 CONTENT 核对")) {
        const who = prompt.includes("scene-guwu") ? "通天古梧" : "年轮大殿";
        steps.push(`核对:${who}`);
        return JSON.stringify({
          pass: false,
          feedback: "通天古梧定妆写进了山门",
          missing: [],
          wrong: ["山门"],
        });
      }
      if (prompt.startsWith("你是定妆 CONTENT 补写")) {
        steps.push("补写:通天古梧");
        treeRewrites += 1;
        if (treeRewrites >= 2)
          return JSON.stringify({ prompt: treeOnlyScene, promptFormat: "scene-content-v1" });
        return JSON.stringify({
          prompt: treeWithGateScene,
          promptFormat: "scene-content-v1",
        });
      }
      throw Error(prompt.slice(0, 40));
    },
    media: {
      files: { get: () => ({ path: "test.png" }) },
      connection: () => ({}),
      ensure: async (_task: string, _rev: number, _kind: string, gen: string) => {
        const who = gen.includes("通天古梧") || gen.includes("ancient wutong") || gen.includes("tree alone")
          ? "通天古梧"
          : "年轮大殿";
        steps.push(`出图:${who}`);
        return who === "通天古梧" ? "tree-img" : "dadian-img";
      },
    },
  } as unknown as Runtime);
  const task = store.tasks(project.id).find((item) => item.stage === 3)!;
  const result = await pipeline.produce(
    task,
    "attempt",
    {} as Connection,
    [],
    "",
    {
      type: "assets",
      data: {
        summary: "两处",
        assets: [treeAsset, { ...asset, prompt: hallScene, state: "正殿" }],
        voices: [],
      },
    },
    new AbortController().signal,
    undefined,
    true,
  );
  expect(treeRewrites).toBe(2);
  const firstImage = steps.findIndex((step) => step.startsWith("出图:"));
  expect(firstImage).toBeGreaterThan(-1);
  expect(firstImage).toBeGreaterThan(steps.lastIndexOf("补写:通天古梧"));
  expect(steps.filter((step) => step.startsWith("出图:"))).toEqual(
    expect.arrayContaining(["出图:通天古梧", "出图:年轮大殿"]),
  );
  expect(steps.slice(0, 4)).toEqual([
    "核对:通天古梧",
    "补写:通天古梧",
    "核对:通天古梧",
    "补写:通天古梧",
  ]);
  const assets = (result.data as { assets: { id: string; imageId?: string }[] }).assets;
  expect(assets.find((item) => item.id === "scene-guwu:default")?.imageId).toBe("tree-img");
  expect(assets.find((item) => item.id === "scene-dadian:default")?.imageId).toBe("dadian-img");
  store.db.close();
});

test("已经核对通过的通天古梧若写进山门，恢复执行仍要打回", async () => {
  const store = new Store(":memory:");
  const project = store.createProject({
    name: "古梧",
    source: "通天古梧",
    inputType: "idea",
    aspect: "16:9",
    template: "cel",
    budget: 0,
  });
  store.patchSettings(project.id, { lookRegistry: treeStory.lookRegistry });
  const storyTask = store.tasks(project.id).find((task) => task.stage === 7)!;
  store.publish(storyTask.id, storyTask.revision, JSON.stringify(treeStory));
  const pipeline = new MediaPipeline({
    store,
    call: async (_task, _attempt, _connection, prompt: string) => {
      if (prompt.startsWith("你是定妆 CONTENT 核对"))
        return JSON.stringify({
          pass: true,
          feedback: "字段齐全",
          missing: [],
          wrong: [],
        });
      if (prompt.startsWith("你是定妆 CONTENT 补写"))
        return JSON.stringify({
          prompt: treeOnlyScene,
          promptFormat: "scene-content-v1",
        });
      throw Error(prompt.slice(0, 40));
    },
    media: {
      files: { get: () => ({ path: "test.png" }) },
      connection: () => ({}),
      ensure: async () => "tree-img",
    },
  } as unknown as Runtime);
  const task = store.tasks(project.id).find((item) => item.stage === 3)!;
  const result = await pipeline.produce(
    task,
    "attempt",
    {} as Connection,
    [],
    "",
    {
      type: "assets",
      data: {
        summary: "树",
        assets: [
          {
            ...treeAsset,
            contentReview: {
              pass: true,
              feedback: "山门与树一体",
              missing: [],
              wrong: [],
              prompt: treeWithGateScene,
            },
          },
        ],
        voices: [],
      },
    },
    new AbortController().signal,
    undefined,
    true,
  );
  expect((result.data as { assets: { prompt: string; imageId?: string }[] }).assets[0].prompt).toBe(
    treeOnlyScene,
  );
  expect((result.data as { assets: { imageId?: string }[] }).assets[0].imageId).toBe("tree-img");
  store.db.close();
});

test("机械已过时旧 CONTENT 核对失败不再挡出图", async () => {
  const store = new Store(":memory:");
  const project = store.createProject({
    name: "旧失败",
    source: "年轮大殿",
    inputType: "idea",
    aspect: "16:9",
    template: "cel",
    budget: 0,
  });
  store.patchSettings(project.id, { lookRegistry: story.lookRegistry });
  const storyTask = store.tasks(project.id).find((task) => task.stage === 7)!;
  store.publish(storyTask.id, storyTask.revision, JSON.stringify(story));
  let reviewed = 0;
  const generated: string[] = [];
  const pipeline = new MediaPipeline({
    store,
    call: async (_task, _attempt, _connection, prompt: string) => {
      if (prompt.startsWith("你是定妆 CONTENT 核对") || prompt.startsWith("你是定妆 CONTENT 补写")) {
        reviewed += 1;
        throw Error("机械已过不应再问模型");
      }
      throw Error(prompt.slice(0, 40));
    },
    media: {
      files: { get: () => ({ path: "test.png" }) },
      connection: () => ({}),
      ensure: async () => {
        generated.push("image");
        return "hall-img";
      },
    },
  } as unknown as Runtime);
  const task = store.tasks(project.id).find((item) => item.stage === 3)!;
  const result = await pipeline.produce(
    task,
    "attempt",
    {} as Connection,
    [],
    "",
    {
      type: "assets",
      data: {
        summary: "殿",
        assets: [
          {
            ...asset,
            prompt: hallScene,
            state: "正殿",
            contentReview: {
              pass: false,
              feedback: "写成了院子，不是室内封闭空间",
              missing: [],
              wrong: ["院子"],
              prompt: hallScene,
            },
          },
        ],
        voices: [],
      },
    },
    new AbortController().signal,
    undefined,
    true,
  );
  expect(reviewed).toBe(0);
  expect(generated).toEqual(["image"]);
  expect((result.data as { assets: { contentReview?: { pass: boolean } }[] }).assets[0].contentReview?.pass).toBe(
    true,
  );
  store.db.close();
});

test("模板或 brief 错误记为待处理，不是连接故障", () => {
  expect(lookPipelineErrorStatus("道具内容需按模板逐项填写")).toBe("needs_user");
  expect(lookPipelineErrorStatus("定妆 brief 自相矛盾，停止出图：匾文和禁止牌匾同时出现")).toBe(
    "needs_user",
  );
  expect(lookPipelineErrorStatus("制作验收：年轮大殿的 CONTENT 核对未通过：写成了院子")).toBe(
    "needs_user",
  );
  expect(lookPipelineErrorStatus("预算不足")).toBe("budget_blocked");
  expect(lookPipelineErrorStatus("Grok 连接超时")).toBe("provider_blocked");
});

test("内容未按模板填写执行后是待处理而不是连接故障", async () => {
  const store = new Store(":memory:");
  const project = store.createProject({
    name: "模板",
    source: "匣",
    inputType: "idea",
    aspect: "16:9",
    template: "donghua3d",
    budget: 0,
  });
  store.patchSettings(project.id, {
    lookRegistry: {
      type: "look-registry",
      entities: [
        {
          id: "box",
          name: "坏匣",
          kind: "prop",
          variants: [
            {
              id: "default",
              name: "坏匣",
              kind: "form",
              identity: "匣",
              form: "未开",
              source: "故事",
            },
          ],
        },
      ],
    },
  });
  const pipeline = new MediaPipeline({
    store,
    call: async () => {
      throw Error("不应再问模型");
    },
    media: {
      files: { get: () => ({ path: "test.png" }) },
      connection: () => ({}),
      ensure: async () => {
        throw Error("未按模板不应出图");
      },
    },
  } as unknown as Runtime);
  const task = store.tasks(project.id).find((item) => item.stage === 3)!;
  store.publish(
    task.id,
    task.revision,
    JSON.stringify({
      type: "assets",
      data: {
        summary: "坏",
        assets: [
          {
            id: "box:default",
            name: "坏匣",
            kind: "prop",
            promptFormat: "prop-content-v1",
            prompt: "Item: a box\nForm: closed",
            identity: "匣",
            state: "未开",
          },
        ],
        voices: [],
      },
    }),
  );
  await pipeline.execute(
    store.task(task.id),
    "attempt",
    {} as Connection,
    {} as Connection,
    [],
    new AbortController().signal,
  );
  expect(store.task(task.id).status).toBe("needs_user");
  expect(store.task(task.id).error).toMatch(/内容需按模板/);
  store.db.close();
});

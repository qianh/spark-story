import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "os";
import {
  mergeStoryRevision,
  storyRevisionContext,
} from "../apps/server/director";
import { Runtime } from "../apps/server/runtime";
import { Store } from "../apps/server/store";
import { readStoredPlan } from "../packages/change-plan";
import { visualStyleKey } from "../packages/visual-style";
import type { Connection } from "../packages/domain";
import { approveFixture, scriptFixture } from "./fixtures/series";

const yaotongStory = {
  type: "story" as const,
  bible: "药童是女童，在药庐帮忙煎药。沈不言是男主。",
  chapters: [
    {
      id: "CH001",
      title: "药庐",
      content: (
        "女童药童捧着药包走到沈不言面前。她把药递过去，袖口沾着药渣。沈不言接过，没有问她从哪来。门外风吹过药帘，药香散开。"
      ).repeat(2),
      continuity: "药童仍是女童，沈不言收下药。",
      beats: [
        { id: "CH001-B001", eventId: "E001", description: "女童送药" },
      ],
    },
  ],
  lookRegistry: {
    type: "look-registry" as const,
    entities: [
      {
        id: "yaotong",
        name: "药童",
        kind: "character" as const,
        variants: [
          {
            id: "child",
            name: "幼年",
            kind: "growth" as const,
            identity: "女童药童，圆脸",
            form: "粗布短打",
            source: "设定：药童是女童",
            ageBand: "child" as const,
          },
        ],
      },
    ],
  },
};

const yaotongPlan = {
  type: "series-plan" as const,
  rationale: "按药庐送药拆一集，便于定妆联调。",
  episodes: [
    {
      id: "EP001",
      title: "药庐",
      sourceBeatIds: ["CH001-B001"],
      summary: "女童送药",
      opening: "药庐日间",
      ending: "沈不言收下药",
      change: "药童出场",
      estimatedSeconds: 90,
      timingReason: "对白与递药动作粗估",
    },
  ],
};

const yaotongMaleStory = {
  ...yaotongStory,
  bible: "药童是男童，在药庐帮忙煎药。沈不言是男主。",
  chapters: [
    {
      ...yaotongStory.chapters[0],
      content: (
        "男童药童捧着药包走到沈不言面前。他把药递过去，袖口沾着药渣。沈不言接过，没有问他从哪来。门外风吹过药帘，药香散开。"
      ).repeat(2),
      continuity: "药童已是男童，沈不言收下药。",
      beats: [
        { id: "CH001-B001", eventId: "E001", description: "男童送药" },
      ],
    },
  ],
  lookRegistry: {
    ...yaotongStory.lookRegistry,
    entities: [
      {
        ...yaotongStory.lookRegistry.entities[0],
        variants: [
          {
            ...yaotongStory.lookRegistry.entities[0].variants[0],
            identity: "男童药童，圆脸",
            source: "用户确认：药童改为男童",
          },
        ],
      },
    ],
  },
};

const genderPlan = {
  clear: true,
  instruction: "药童改为男童，并同步剧情、设定与定妆",
  explanation: "身份事实变了，须从故事稿改起",
  origin: "story",
  change: [
    { action: "revise_story", title: "完整故事稿中的药童" },
    { action: "revise_look_registry", targetId: "yaotong", title: "药童外观登记" },
    { action: "revise_episode_script", targetId: "EP001", title: "第1集剧本" },
    { action: "revise_asset_prompt", targetId: "yaotong:child", title: "药童定妆提示词" },
    { action: "regenerate_asset", targetId: "yaotong:child", title: "药童定妆图" },
  ],
  invalidate: [{ title: "含药童的分镜与成片", reason: "画面仍是女童" }],
  keep: [
    { title: "故事概要", reason: "未写性别" },
    { title: "沈不言定妆", reason: "未涉及" },
  ],
};

const resources: { root: string; s: Store; r: Runtime }[] = [];

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw Error("运行未在预期时间内完成");
}

async function setup(reply: (prompt: string) => string) {
  const root = await mkdtemp(join(tmpdir(), "spark-director-"));
  const s = new Store(":memory:");
  const p = s.createProject({
    name: "药童",
    source: "药庐",
    inputType: "idea",
    aspect: "9:16",
    template: "cel",
    budget: 0,
  });
  s.patchSettings(p.id, { modelReviewEnabled: false });
  const c: Connection = {
    id: "cli",
    name: "测试",
    transport: "cli",
    provider: "codex",
    executable: "/test/codex",
    model: "",
    baseUrl: "",
    keyEnv: "",
    reserveCents: 0,
    health: "installed",
    version: "test",
  };
  s.saveConnection(c);
  for (const role of ["主模型", "文本模型"])
    s.db.run("INSERT INTO bindings VALUES(?,?)", [role, c.id]);
  approveFixture(s, p.id, 0, "仙侠短剧，药庐里有一个药童。");
  approveFixture(s, p.id, 7, JSON.stringify(yaotongStory));
  approveFixture(s, p.id, 1, JSON.stringify(yaotongPlan));
  approveFixture(
    s,
    p.id,
    2,
    scriptFixture(1).replace(
      "雨中相遇",
      "女童药童把药递给沈不言。她退到药柜旁。",
    ),
    1,
  );
  const looks = s.tasks(p.id).find((t) => t.stage === 3)!;
  const styleKey = visualStyleKey(s.visualStyle(p.id));
  s.publish(
    looks.id,
    looks.revision,
    JSON.stringify({
      type: "assets",
      data: {
        summary: "全剧",
        assets: [
          {
            id: "yaotong:child",
            name: "药童",
            kind: "character",
            prompt:
              "Subject: child East Asian female xianxia 药童, small frame.\nFace: round.\nHair: black, short.\nCostume:\n- Inner robe: coarse cloth",
            promptFormat: "character-content-v1",
            identity: "女童药童，圆脸",
            state: "粗布短打",
            entityId: "yaotong",
            variantId: "child",
            growthStage: "child",
            imageId: "old-girl",
            generationPrompt: "old girl prompt",
            generationStyleKey: styleKey,
          },
          {
            id: "shen",
            name: "沈不言",
            kind: "character",
            prompt: "Subject: youth East Asian male xianxia 沈不言",
            promptFormat: "character-content-v1",
            identity: "男主",
            state: "青衫",
            imageId: "shen-img",
            generationPrompt: "shen",
            generationStyleKey: styleKey,
          },
        ],
        voices: [],
      },
    }),
  );
  const r = new Runtime(s, root, async (_c, prompt) => reply(prompt));
  r.media.ensure = async () => "new-boy";
  r.media.files.get = ((id: string) => ({
    id,
    path: `${id}.png`,
    mime: "image/png",
    name: id,
  })) as any;
  resources.push({ root, s, r });
  return { s, r, p, looks };
}

afterEach(async () => {
  for (const { root, s, r } of resources.splice(0)) {
    r.shutdown();
    await waitFor(() => r.active.size === 0);
    s.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("主控把女童改男童做成待确认的影响范围，不立刻改产物", async () => {
  const { s, r, looks } = await setup((prompt) => {
    if (prompt.startsWith("你是主控")) return JSON.stringify(genderPlan);
    throw Error("不应开始改稿");
  });
  r.intervene(looks.id, looks.revision, "药童改成男童");
  await waitFor(() => s.task(looks.id).status === "needs_user");
  const row = s.one<any>("SELECT * FROM interventions ORDER BY createdAt DESC LIMIT 1")!;
  const plan = readStoredPlan(row.proposal)!;
  expect(plan.change.map((c) => c.action)).toContain("revise_story");
  expect(plan.keep.some((k) => k.title.includes("概要"))).toBe(true);
  const story = s.one<any>(
    "SELECT a.content FROM artifacts a JOIN tasks t ON t.id=a.taskId WHERE t.stage=7 AND a.status='approved'",
  )!;
  expect(story.content).toContain("女童");
  expect(story.content).not.toContain("男童药童");
});

test("只改图的方案不能确认执行", async () => {
  const { s, r, looks } = await setup(() =>
    JSON.stringify({
      clear: true,
      instruction: "重出药童",
      explanation: "只重画",
      origin: "story",
      change: [
        { action: "regenerate_asset", targetId: "yaotong:child", title: "药童" },
      ],
    }),
  );
  r.intervene(looks.id, looks.revision, "药童改成男童");
  await waitFor(() => s.task(looks.id).status === "needs_user");
  const row = s.one<any>("SELECT * FROM interventions ORDER BY createdAt DESC LIMIT 1")!;
  expect(row.status).toBe("awaiting_confirmation");
  expect(row.proposal).toContain("不允许只改提示词或只重出图");
  expect(() => r.confirm(row.id)).toThrow("不允许只改提示词或只重出图");
});

test("确认后从故事设定改到定妆重出，保留无关角色", async () => {
  const { s, r, p, looks } = await setup((prompt) => {
    if (prompt.startsWith("你是主控")) return JSON.stringify(genderPlan);
    if (prompt.startsWith("你是故事修订")) return JSON.stringify(yaotongMaleStory);
    if (prompt.startsWith("你是外观登记修订"))
      return JSON.stringify(yaotongMaleStory.lookRegistry.entities[0]);
    if (prompt.startsWith("你是剧本修订"))
      return scriptFixture(1).replace(
        "雨中相遇",
        "男童药童把药递给沈不言。他退到药柜旁。",
      );
    if (prompt.startsWith("你是定妆事实修订"))
      return JSON.stringify({
        prompt:
          "Subject: child East Asian male xianxia 药童, small frame.\nFace: round.\nHair: black, short.\nCostume:\n- Inner robe: coarse cloth",
        promptFormat: "character-content-v1",
        identity: "男童药童，圆脸",
        state: "粗布短打",
      });
    throw Error(prompt.slice(0, 40));
  });
  r.intervene(looks.id, looks.revision, "药童改成男童");
  await waitFor(() => s.task(looks.id).status === "needs_user");
  const row = s.one<any>("SELECT * FROM interventions ORDER BY createdAt DESC LIMIT 1")!;
  r.confirm(row.id);
  expect(s.task(looks.id).status).toBe("coordinating");
  await waitFor(() => {
    const looksArt = s.one<{ content: string }>(
      "SELECT content FROM artifacts WHERE taskId=? ORDER BY rowid DESC LIMIT 1",
      looks.id,
    );
    return !!looksArt?.content.includes("new-boy");
  });
  await waitFor(() => s.task(looks.id).status === "awaiting_user");
  expect(s.lookRegistry(p.id)?.entities[0].variants[0].identity).toContain("男童");
  const script = s.one<{ content: string }>(
    "SELECT a.content FROM artifacts a JOIN tasks t ON t.id=a.taskId WHERE t.stage=2 AND t.episode=1 AND a.status='approved' ORDER BY a.createdAt DESC LIMIT 1",
  )!;
  expect(script.content).toContain("他退到药柜旁");
  const assets = JSON.parse(
    s.one<{ content: string }>(
      "SELECT content FROM artifacts WHERE taskId=? ORDER BY rowid DESC LIMIT 1",
      looks.id,
    )!.content,
  );
  const yaotong = assets.data.assets.find((a: any) => a.id === "yaotong:child");
  const shen = assets.data.assets.find((a: any) => a.id === "shen");
  expect(yaotong.identity).toContain("男童");
  expect(yaotong.prompt).toContain("male");
  expect(yaotong.imageId).toBe("new-boy");
  expect(shen.imageId).toBe("shen-img");
  expect(s.task(s.tasks(p.id).find((t) => t.stage === 0)!.id).status).toBe(
    "approved",
  );
  expect(s.task(looks.id).status).toBe("awaiting_user");
});

test("故事修订只带目标章，补丁写回后其它章不动", () => {
  const story = {
    type: "story" as const,
    bible: "青梧宗。",
    chapters: [
      {
        id: "CH001",
        title: "入宗",
        content: "沈不言抱着她走进年轮大殿，放到厚毡上。药香、剑油和阵墨混进从殿外渗入的湿雾。掌门远看着本根，没有催。".repeat(2),
        continuity: "入宗",
        beats: [{ id: "CH001-B001", eventId: "E001", description: "入宗" }],
      },
      {
        id: "CH006",
        title: "问道",
        content: "问道台是白石台面，人站上去像站在一张石桌上。四周宗门旗多，青梧旗旧，年轮中心空着。".repeat(2),
        continuity: "台小",
        beats: [{ id: "CH006-B001", eventId: "E006", description: "问道" }],
      },
    ],
    lookRegistry: {
      type: "look-registry" as const,
      entities: [
        {
          id: "scene-wendao-tai",
          name: "问道台",
          kind: "scene" as const,
          variants: [
            {
              id: "default",
              name: "问道台",
              kind: "form" as const,
              identity: "盟会问道台",
              form: "白石台面",
              source: "CH006",
            },
          ],
        },
      ],
    },
  };
  const ctx = storyRevisionContext(story, {
    action: "revise_story",
    targetId: "CH006",
    title: "问道台改为大型白石高台",
  });
  const packed = JSON.stringify(ctx);
  expect(packed).toContain("白石台面");
  expect(packed).not.toContain("年轮大殿");
  const next = mergeStoryRevision(story, {
    chapters: [
      {
        ...story.chapters[1],
        content: "问道台是盟会云脊正道坪上可容人立、诸宗围观的大型白石高台。四周宗门旗多，青梧旗旧，年轮中心空着。".repeat(3),
      },
    ],
    lookEntities: [
      {
        ...story.lookRegistry.entities[0],
        variants: [
          {
            ...story.lookRegistry.entities[0].variants[0],
            form: "大型白石高台，可容人立、诸宗围观",
          },
        ],
      },
    ],
  });
  expect(next.chapters[0].content).toContain("年轮大殿");
  expect(next.chapters[1].content).toContain("大型白石高台");
  expect(next.lookRegistry?.entities[0].variants[0].form).toContain("可容人立");
});

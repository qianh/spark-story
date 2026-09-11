import { timingManifest } from "../packages/production";
import { assetPlanSchema, voiceSampleSchema, isAssetImageLocked } from "../packages/media";
import { mergeVoiceCards } from "../apps/server/voice-casting";
import { expect, test } from "bun:test";
import { Store } from "../apps/server/store";
import {
  lookImageConcurrency,
  MediaPipeline,
} from "../apps/server/media-pipeline";
import type { Runtime } from "../apps/server/runtime";
import { templates, type Artifact, type Connection } from "../packages/domain";
import { characterContentTemplate, visualStyleKey } from "../packages/visual-style";
import { approveFixture, storyFixture, scriptFixture, seedSeries } from "./fixtures/series";

const prop = (id = "token:whole") => ({
  id, name: "信物", kind: "prop", promptFormat: "prop-content-v1",
  prompt: `CONTENT — PROP (fill per item):\nItem: jade token\nSize impression: palm-size\nMaterials: jade\nForm: rectangular plaque\nOrnament: plain\nColor accents: muted jade\nCondition: intact, dry, well kept\nUnique marks: clan emblem\nView: full item, slight three-quarter`,
  identity: "方形玉牌", state: "完整", entityId: "token", variantId: id.split(":")[1],
});
function setup(
  template: string,
  response?: (prompt: string) => unknown,
  delayMs = 0,
) {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "画风全流程", source: "信物传承", inputType: "idea", aspect: "16:9", template, budget: 0 });
  const calls: { prompt: string; options: any; refs: string[]; force?: boolean }[] = [];
  const stats = { inflight: 0, peak: 0 };
  const pipeline = new MediaPipeline({
    store,
    call: async (_task: unknown, _attempt: unknown, _connection: unknown, prompt: string) => JSON.stringify(response?.(prompt)),
    media: { files: { get: () => ({path:"test-image.png"}) }, connection: () => ({}), ensure: async (_task: string, _revision: number, _kind: string, prompt: string, refs: string[], options: any, _signal?: AbortSignal, _progress?: unknown, force?: boolean) => {
      stats.inflight++;
      stats.peak = Math.max(stats.peak, stats.inflight);
      const n = calls.push({ prompt, options, refs, force });
      if (delayMs) await Bun.sleep(delayMs);
      stats.inflight--;
      return `image-${n}`;
    } },
  } as unknown as Runtime);
  const produce = (edited: unknown, upstream: Artifact[] = []) => pipeline.produce(
    store.tasks(project.id).find((t) => t.stage === 3)!, "attempt", {} as Connection,
    upstream, "", edited, new AbortController().signal,
  );
  const checkpoint = () => {
    const task = store.tasks(project.id).find((t) => t.stage === 3)!;
    return JSON.parse(store.one<{ content: string }>("SELECT content FROM artifacts WHERE taskId=? AND revision=? ORDER BY rowid DESC LIMIT 1", task.id, task.revision)!.content);
  };
  return { store, project, calls, stats, produce, checkpoint, pipeline };
}

for (const target of templates.filter((t) => t.id !== "donghua3d")) test(`切换到 ${target.name} 后检查点真正重新请求生图并使用所选画风`, async () => {
  const f = setup(target.id === "cel" ? "ink" : "cel");
  try {
    const original = await f.produce({ type: "assets", data: { summary: "全剧信物", assets: [prop()], voices: [] } });
    f.store.setVisualTemplate(f.project.id, target.id);
    const result = await f.produce(f.checkpoint());
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].prompt).toContain(f.store.visualStyle(f.project.id).prompt);
    const asset = (result.data as any).assets[0];
    expect(asset.imageId).not.toBe((original.data as any).assets[0].imageId);
    expect(asset.generationStyleKey).toBe(visualStyleKey(f.store.visualStyle(f.project.id)));
    expect(f.calls[1].options.visualRevision).toBe(1);
  } finally { f.store.db.close(); }
});

test("更换参考后重试使用新参考，并拒绝选用旧画风候选", async () => {
  const f = setup("ink", () => ({pass:true,feedback:"符合水墨"}));
  try {
    f.store.binding = () => ({} as Connection);
    await f.produce({type:"assets",data:{summary:"全剧",assets:[prop()],voices:[]}});
    const old = f.checkpoint();
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    f.store.db.run("INSERT INTO media_files VALUES(?,?,?,?,?,?,?,?,?,?)", ["reference",f.project.id,task.id,task.revision,"image","reference","test-image.png","image/png","{}",new Date().toISOString()]);
    f.store.setVisualReference(f.project.id,"reference");
    const current = f.store.task(task.id);
    // Even a legacy checkpoint manually reintroduced cannot make retry use its old refs.
    old.data.assets[0].generationReferenceIds = ["old-reference"];
    f.store.publish(current.id,current.revision,JSON.stringify(old));
    await expect(f.pipeline.selectAsset(current,prop().id,old.data.assets[0].imageId)).rejects.toThrow("旧画风");
    const result = await f.pipeline.retryAsset(current,prop().id,new AbortController().signal);
    expect(f.calls.at(-1)!.refs).toEqual(["reference"]);
    expect(f.calls.at(-1)!.prompt).toContain("Reference 1: production style only");
    const candidate = result.data.assets[0].candidates!.at(-1)!;
    expect(result.data.assets[0].candidateSpecs![candidate].referenceIds).toEqual(["reference"]);
    expect(result.data.assets[0].candidateSpecs![candidate].passed).toBe(true);
    const before = f.store.tasks(f.project.id).find(t=>t.stage===4)!;
    const selected = await f.pipeline.selectAsset(current,prop().id,candidate);
    expect(selected.data.assets[0].generationStyleKey).toBe(visualStyleKey(f.store.visualStyle(f.project.id)));
    expect(f.store.task(before.id).revision).toBe(before.revision+1);
  } finally {f.store.db.close();}
});

test("画风 A→B→A 的生成缓存参数不同，恢复同一检查点则不重复生图", async () => {
  const f = setup("cel");
  try {
    await f.produce({ type: "assets", data: { summary: "信物", assets: [prop()], voices: [] } });
    await f.produce(f.checkpoint());
    expect(f.calls).toHaveLength(1);
    for (const style of ["ink", "cel"]) {
      f.store.setVisualTemplate(f.project.id, style);
      await f.produce(f.checkpoint());
    }
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0].prompt).toBe(f.calls[2].prompt);
    expect(f.calls.map((c) => c.options.visualRevision)).toEqual([0, 1, 2]);
    expect(f.calls[0].options).not.toEqual(f.calls[2].options);
  } finally { f.store.db.close(); }
});

test("全剧定妆按集增量：第一集不必出后段变体，已有资产再补后集", async () => {
  const prompts: string[] = [];
  const f = setup("cel", (prompt) => {
    prompts.push(prompt);
    if (prompt.includes("token:broken"))
      return { summary: "补后集", assets: [{ ...prop("token:broken"), state: "断裂", name: "断裂信物" }], voices: [] };
    return { summary: "第一集信物", assets: [prop()], voices: [] };
  });
  try {
    approveFixture(f.store, f.project.id, 0, "概要");
    const story = { ...storyFixture, lookRegistry: { type: "look-registry", entities: [{ id: "token", name: "信物", kind: "prop", variants: [
      { id: "whole", name: "完整", kind: "form", identity: "玉牌", form: "完整", source: "第一章", fromBeatId: "CH001-B001" },
      { id: "broken", name: "断裂", kind: "form", identity: "玉牌", form: "断裂", source: "第二章", fromBeatId: "CH002-B001" },
    ] }] } };
    approveFixture(f.store, f.project.id, 7, JSON.stringify(story));
    const task = f.store.tasks(f.project.id).find((t) => t.stage === 3)!;
    expect(task.episode).toBe(0);
    const upstream = f.store.upstream(task);
    const first = await f.produce(null, upstream);
    expect((first.data as any).assets.map((a: any) => a.id)).toEqual(["token:whole"]);
    expect(prompts[0]).toContain("token:whole");
    expect(prompts[0]).toContain("按集");
    expect(prompts[0]).not.toMatch(/本批必须提供[\s\S]*token:broken/);
    expect(f.calls).toHaveLength(1);
    const second = await f.produce(first, upstream);
    expect((second.data as any).assets.map((a: any) => a.id)).toEqual([
      "token:whole",
      "token:broken",
    ]);
    expect((second.data as any).assets[0].imageId).toBe((first.data as any).assets[0].imageId);
    expect(f.calls).toHaveLength(2);
  } finally { f.store.db.close(); }
});

const shenLook = () => ({
  id: "shen-buyan:youth",
  name: "沈不言",
  kind: "character" as const,
  promptFormat: "character-content-v1" as const,
  prompt: characterContentTemplate.replace(/\[[^\]]+\]/g, "none").replace("Subject: none", "Subject: youth Chinese male sword cultivator Shen Buyan"),
  identity: "青梧宗青年剑修",
  state: "基础定妆",
});

test("通用仙侠独立生图，不向其他人物和道具传递沈不言", async () => {
  const f = setup("donghua3d", () => ({ voices: [] }));
  try {
    await f.produce({ type: "assets", data: { summary: "只有道具", assets: [prop()], voices: [] } });
    expect(f.calls[0].refs).toEqual([]);
    f.calls.length = 0;
    const girl = {
      ...shenLook(),
      id: "su-wanqing:child",
      name: "苏晚晴",
      prompt: shenLook().prompt.replace("Shen Buyan", "Su Wanqing").replace("youth Chinese male", "child Chinese girl"),
    };
    await f.produce({
      type: "assets",
      data: { summary: "主参考先出", assets: [shenLook(), girl, prop()], voices: [] },
    }).catch((error) => {
      if (!String(error.message).includes("声音")) throw error;
    });
    expect(f.store.visualStyle(f.project.id).referenceImageId).toBeFalsy();
    expect(f.calls[0].prompt).toContain("Shen Buyan");
    const later = f.calls.slice(1);
    expect(later.every((c) => c.prompt.startsWith("UNIVERSAL XIANXIA STYLE\n"))).toBe(true);
    expect(later.every((c) => !/REFERENCE ROLES|SAME SERIES STAGE|MODULE —/.test(c.prompt))).toBe(true);
    expect(later.every((c) => c.refs.length === 0)).toBe(true);
  } finally {
    f.store.db.close();
  }
});

test("定妆出图主参考先出，其余最多三路并发", async () => {
  const f = setup("donghua3d", () => ({ voices: [] }), 40);
  try {
    const extras = ["su-wanqing:child", "token:whole", "gate:main", "hall:main"].map(
      (id, i) =>
        i === 0
          ? {
              ...shenLook(),
              id,
              name: "苏晚晴",
              prompt: shenLook().prompt.replace("Shen Buyan", "Su Wanqing"),
            }
          : i === 1
            ? prop(id)
            : {
                id,
                name: id === "gate:main" ? "山门" : "大殿",
                kind: "scene" as const,
                promptFormat: "scene-content-v1" as const,
                prompt: `CONTENT — SCENE (fill per location):
Place: ${id === "gate:main" ? "sect mountain gate" : "main hall"}
Time / weather: overcast day
Near camera: carved columns
Mid: axial path
Far: designed ink peaks
Materials: dark timber
Set dressing: none
People: none
Camera: wide establishing`,
                identity: id,
                state: "基础",
              },
    );
    await f
      .produce({
        type: "assets",
        data: { summary: "并发", assets: [shenLook(), ...extras], voices: [] },
      })
      .catch((error) => {
        if (!String(error.message).includes("声音")) throw error;
      });
    expect(f.calls[0].prompt).toContain("Shen Buyan");
    expect(f.calls).toHaveLength(5);
    expect(f.stats.peak).toBe(lookImageConcurrency);
    expect(f.calls.slice(1).every((c) => c.refs.length === 0)).toBe(true);
  } finally {
    f.store.db.close();
  }
});

test("没有主参考依赖时定妆仍三路并发", async () => {
  const f = setup("cel", undefined, 40);
  try {
    await f.produce({
      type: "assets",
      data: {
        summary: "一批",
        assets: ["a:1", "b:1", "c:1", "d:1"].map((id) => prop(id)),
        voices: [],
      },
    });
    expect(f.calls).toHaveLength(4);
    expect(f.stats.peak).toBe(lookImageConcurrency);
  } finally {
    f.store.db.close();
  }
});

test("已确认定妆可开新修订追加后集，保留已有资产", async () => {
  const f = setup("cel", () => ({ summary: "第一集信物", assets: [prop()], voices: [] }));
  try {
    approveFixture(f.store, f.project.id, 0, "概要");
    const story = {
      ...storyFixture,
      lookRegistry: {
        type: "look-registry",
        entities: [
          {
            id: "token",
            name: "信物",
            kind: "prop",
            variants: [
              { id: "whole", name: "完整", kind: "form", identity: "玉牌", form: "完整", source: "第一章", fromBeatId: "CH001-B001" },
              { id: "broken", name: "断裂", kind: "form", identity: "玉牌", form: "断裂", source: "第二章", fromBeatId: "CH002-B001" },
            ],
          },
        ],
      },
    };
    approveFixture(f.store, f.project.id, 7, JSON.stringify(story));
    const upstream = f.store.upstream(f.store.tasks(f.project.id).find((t) => t.stage === 3)!);
    await f.produce(null, upstream);
    const task = f.store.tasks(f.project.id).find((t) => t.stage === 3)!;
    const art = f.store.one<{ id: string }>(
      "SELECT id FROM artifacts WHERE taskId=? AND revision=? ORDER BY rowid DESC LIMIT 1",
      task.id,
      task.revision,
    )!;
    f.store.db.run("UPDATE artifacts SET status='approved' WHERE id=?", [art.id]);
    f.store.db.run("UPDATE tasks SET status='approved' WHERE id=?", [task.id]);
    const next = f.store.extendApprovedLooks(task.id);
    expect(next.status).toBe("ready");
    expect(next.revision).toBe(task.revision + 1);
    const copied = JSON.parse(
      f.store.one<{ content: string }>(
        "SELECT content FROM artifacts WHERE taskId=? AND revision=?",
        next.id,
        next.revision,
      )!.content,
    );
    expect(copied.data.assets.map((a: { id: string }) => a.id)).toEqual(["token:whole"]);
    expect(copied.data.extendLookPlan).toBe(true);
  } finally {
    f.store.db.close();
  }
});

test("通用仙侠即使保存了人物主参考，也不传给其他角色、道具和空景", () => {
  const f = setup("donghua3d");
  try {
    f.store.bindMasterLookRef(f.project.id, "shen-reference");
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    const source = { ...shenLook(), imageId: "shen-reference" };
    const other = { ...shenLook(), id: "gu:youth", name: "顾行舟" };
    const scene = { ...source, id: "gate:main", name: "山门", kind: "scene" as const };
    for (const asset of [other, scene, { ...source, kind: "prop" as const, id: "sword:main" }]) {
      expect(f.pipeline.assetReferences(task, asset, [source, asset]).ids).toEqual([]);
    }
    expect(() => f.pipeline.assetReferences(task, { ...scene, sourceAssetId: source.id }, [source, scene])).toThrow("场景定妆只能使用场景参考");
    expect(f.pipeline.assetReferences(task, other, [other], "gu-own-reference").ids).toEqual(["gu-own-reference"]);
  } finally { f.store.db.close(); }
});

test("声音只按当前制作需要排队，保存仍是全剧并保留其他角色和成长阶段", () => {
  const f = setup("cel");
  try {
    seedSeries(f.store, f.project.id);
    const manifest = timingManifest(scriptFixture())!;
    manifest.episodes[0].beats.forEach((b, i) => { if (b.performance) b.performance.dialogue = i === 0 ? [{ speaker: "沈不言", text: "还活着。" }] : []; });
    approveFixture(f.store, f.project.id, 2, '```production-json\n' + JSON.stringify(manifest) + '\n```', 1);
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    const data = assetPlanSchema.parse({ summary: "全剧", assets: [shenLook(), { ...shenLook(), id: "su:child", name: "苏晚晴", growthStage: "child" }], voices: [] });
    expect(f.pipeline.voiceBatchAssets(task, data).map(a => a.name)).toEqual(["沈不言"]);
    const old = voiceSampleSchema.parse({ character: "苏晚晴", growthStage: "child", voice: "VoiceDesign", sampleText: "保留", audioId: "su-saved" });
    const grown = { ...old, growthStage: "youth", audioId: "su-youth" };
    const updated = voiceSampleSchema.parse({ character: "沈不言", growthStage: "youth", voice: "VoiceDesign", sampleText: "新生成", audioId: "shen-new" });
    expect(mergeVoiceCards([old, grown], [updated])).toEqual([old, grown, updated]);
    manifest.episodes[0].beats.forEach((b, i) => { if (b.performance) b.performance.dialogue = i === 0 ? [{ speaker: "苏晚晴", text: "别走。" }] : []; });
    approveFixture(f.store, f.project.id, 2, '```production-json\n' + JSON.stringify(manifest) + '\n```', 1);
    expect(f.pipeline.voiceBatchAssets(task, data).map(a => a.name)).toEqual(["苏晚晴"]);
    expect(data.assets).toHaveLength(2);
  } finally { f.store.db.close(); }
});

for (const invalid of [false, true]) test(`旧故事缺少外观登记时先补登记再定妆（无效返回=${invalid}）`, async () => {
  const prompts: string[] = [];
  const registry = { type: "look-registry", entities: [{ id: "token", name: "信物", kind: "prop", variants: [{ id: "whole", name: "完整", kind: "form", identity: "玉牌", form: "完整", source: "故事设定" }] }] };
  const f = setup("cel", (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("你是外观登记 Agent")) return invalid ? { type: "look-registry", entities: [] } : registry;
    return { summary: "定妆", assets: [prop()], voices: [] };
  });
  try {
    approveFixture(f.store, f.project.id, 0, "概要");
    approveFixture(f.store, f.project.id, 7, JSON.stringify(storyFixture));
    if (invalid) {
      await expect(f.produce(null)).rejects.toThrow("外观登记");
      expect(f.calls).toHaveLength(0);
      expect(f.store.lookRegistry(f.project.id)).toBeUndefined();
      expect(prompts).toHaveLength(1);
    } else {
      await f.produce(null);
      expect(prompts[0]).toStartWith("你是外观登记 Agent");
      expect(prompts[1]).toContain("本批必须提供：token:whole");
      expect(f.store.lookRegistry(f.project.id)).toEqual(registry);
      await f.produce(f.checkpoint());
      expect(prompts.filter(p => p.startsWith("你是外观登记 Agent"))).toHaveLength(1);
    }
  } finally { f.store.db.close(); }
});

test("空定妆结果提示可操作错误而非底层数组校验", async () => {
  const f = setup("cel", () => ({ summary: "无新项", assets: [], voices: [] }));
  try { await expect(f.produce(null)).rejects.toThrow("未返回任何定妆资产"); }
  finally { f.store.db.close(); }
});

test("单张审核使用该候选实际生成提示词，不用已选旧图或额外场景标准", async () => {
  const prompts: string[] = [];
  const f = setup("cel", prompt => {
    prompts.push(prompt);
    return { pass: true, feedback: "符合实际提示词" };
  });
  try {
    f.store.binding = () => ({} as Connection);
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    const asset = assetPlanSchema.parse({ summary: "候选", assets: [{
      ...prop(), imageId: "old", generationPrompt: "旧图使用的提示词",
      candidateSpecs: { candidate: { prompt: "湿雾中的玉牌，背景有路人", styleKey: "test", styleVersion: "test", referenceIds: [] } },
    }] }).assets[0];
    await f.pipeline.reviewAssetImage(task, asset, "candidate", [], new AbortController().signal);
    expect(prompts[0]).toContain("湿雾中的玉牌，背景有路人");
    expect(prompts[0]).not.toContain("旧图使用的提示词");
    expect(prompts[0]).not.toContain("场景与建筑必须完全无人");
    expect(prompts[0]).toContain("逐项引用");
  } finally { f.store.db.close(); }
});

test("定妆登记中的体型比喻和湿雾不触发独立禁词验收", async () => {
  const f = setup("cel");
  try {
    const result = await f.produce({ type: "assets", data: { summary: "定妆", voices: [], assets: [{
      ...prop(), identity: "幼女身量，抱起来不沉", state: "湿雾中的玉牌",
    }] } });
    expect(f.calls).toHaveLength(1);
    expect((result.data as any).assets[0].identity).toBe("幼女身量，抱起来不沉");
  } finally { f.store.db.close(); }
});

test("逐张审核落盘，超过三轮只重做失败图片，全部通过才交给用户", async () => {
  const reviewed: string[] = [];
  let planning = 0;
  const f = setup("cel", prompt => {
    if (prompt.startsWith("你是角色与资产 Agent")) {
      planning++;
      return { summary: "两张", assets: [prop("a:whole"), prop("b:whole")], voices: [] };
    }
    const name = prompt.match(/产物名称：(image-\d+)/)?.[1];
    if (name) {
      expect(prompt).not.toContain("产物上下文：");
      expect(prompt).not.toContain("任务要求：");
      reviewed.push(name);
      return { pass: name === "image-1" || reviewed.length >= 6, feedback: "玉牌边缘需要完整" };
    }
    return { pass: true, feedback: "通过" };
  });
  try {
    const runtime = f.pipeline.runtime as any;
    runtime.media.files.get = (id: string) => ({ id, kind: "image", name: id, path: id, metadata: "{}" });
    runtime.media.files.inspectFrames = async (id: string) => [id];
    runtime.reviewBatch = async (_t: any, _m: any, signal: AbortSignal, run: any) => run(undefined, signal);
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    await f.pipeline.execute(task, "test", {} as Connection, {} as Connection, [], new AbortController().signal);
    expect(f.store.task(task.id).status).toBe("awaiting_user");
    expect(planning).toBe(1);
    expect(reviewed.filter(id => id === "image-1")).toHaveLength(1);
    expect(f.calls).toHaveLength(6);
    expect(f.calls.slice(2).every(c => c.force)).toBe(true);
    expect(f.calls[2].prompt).toContain("玉牌边缘需要完整");
    const saved = f.checkpoint();
    expect(saved.data.assets.every((a: any) => a.imageReview?.pass)).toBe(true);
    const before = reviewed.length;
    await f.pipeline.execute(f.store.task(task.id), "resume", {} as Connection, {} as Connection, [], new AbortController().signal);
    expect(reviewed).toHaveLength(before);
    expect(f.calls).toHaveLength(6);
  } finally { f.store.db.close(); }
});

test("审核中途断线仍保存已通过锁，恢复只审核剩余图片", async () => {
  const reviewed: string[] = [];
  let disconnected = true;
  const f = setup("cel", prompt => {
    if (prompt.startsWith("你是角色与资产 Agent")) return { summary: "两张", assets: [prop("a:whole"), prop("b:whole")], voices: [] };
    const name = prompt.match(/产物名称：(image-\d+)/)?.[1];
    if (name) {
      reviewed.push(name);
      if (name === "image-2" && disconnected) throw Error("模拟审核连接断开");
    }
    return { pass: true, feedback: "通过" };
  });
  try {
    const runtime = f.pipeline.runtime as any;
    runtime.media.files.get = (id: string) => ({ id, kind: "image", name: id, path: id, metadata: "{}" });
    runtime.media.files.inspectFrames = async (id: string) => [id];
    runtime.reviewBatch = async (_t: any, _m: any, signal: AbortSignal, run: any) => run(undefined, signal);
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    await f.pipeline.execute(task, "test", {} as Connection, {} as Connection, [], new AbortController().signal);
    expect(f.store.task(task.id).status).toBe("provider_blocked");
    expect(f.checkpoint().data.assets[0].imageReview.pass).toBe(true);
    disconnected = false;
    await f.pipeline.execute(f.store.task(task.id), "resume", {} as Connection, {} as Connection, [], new AbortController().signal);
    expect(f.store.task(task.id).status).toBe("awaiting_user");
    expect(f.calls).toHaveLength(2);
    expect(reviewed.filter(id => id === "image-1")).toHaveLength(1);
    expect(reviewed.filter(id => id === "image-2")).toHaveLength(2);
  } finally { f.store.db.close(); }
});


test("图片锁绑定图片和生成提示词，换图后旧审核不能沿用", () => {
  const asset = { imageId: "a", generationPrompt: "要求", imageReview: { imageId: "a", prompt: "要求", pass: true } };
  expect(isAssetImageLocked(asset)).toBe(true);
  expect(isAssetImageLocked({ ...asset, imageId: "b" })).toBe(false);
  expect(isAssetImageLocked({ ...asset, generationPrompt: "新要求" })).toBe(false);
  expect(isAssetImageLocked({ ...asset, imageId: undefined })).toBe(false);
});

test("旧审核失败图片先按新优先级复审，不因旧意见直接重画", async () => {
  const f = setup("cel");
  try {
    await f.produce({ type: "assets", data: { summary: "玉牌", assets: [prop()], voices: [] } });
    const old = f.checkpoint();
    old.data.assets[0].imageReview = { imageId: old.data.assets[0].imageId, prompt: old.data.assets[0].generationPrompt, pass: false, feedback: "误把通用服装示例当成硬性要求" };
    old.data.assets[0].imageRepairFeedback = "旧的误判意见";
    const result = await f.produce(old);
    expect(f.calls).toHaveLength(1);
    expect((result.data as any).assets[0].imageId).toBe(old.data.assets[0].imageId);
  } finally { f.store.db.close(); }
});

test("恢复修订号变化仍沿用已有定妆计划，不自动规划后集", async () => {
  let plans = 0;
  const f = setup("cel", () => { plans++; throw Error("不应重新规划"); });
  try {
    const task = f.store.tasks(f.project.id).find(t => t.stage === 3)!;
    f.store.patchSettings(f.project.id, { lookRegistry: { type: "look-registry", entities: [
      { id: "token", name: "信物", kind: "prop", variants: [{ id: "whole", name: "完整", kind: "form", identity: "玉牌", form: "完整", source: "故事" }] },
      { id: "later", name: "后集资产", kind: "prop", variants: [{ id: "whole", name: "完整", kind: "form", identity: "玉牌", form: "完整", source: "后集" }] },
    ] } });
    const result = await f.pipeline.produce(task, "test", {} as Connection, [], "", { type: "assets", data: { summary: "当前批次", lookPlanRevision: task.revision - 1, assets: [prop()], voices: [] } }, new AbortController().signal, undefined, true);
    expect(plans).toBe(0);
    expect((result.data as any).assets).toHaveLength(1);
  } finally { f.store.db.close(); }
});

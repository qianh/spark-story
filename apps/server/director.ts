import {
  assertChangePlan,
  changePlanSchema,
  formatChangePlan,
  looksWithoutUpstream,
  sortChangeItems,
  type ChangeItem,
  type ChangePlan,
} from "../../packages/change-plan";
import { mediaBundle } from "../../packages/media";
import {
  lookEntitySchema,
  parseLookAssetId,
  type LookEntity,
} from "../../packages/look-registry";
import { storySchema, structured, type Story } from "../../packages/series";
import { parseResult } from "./connectors";
import type { Runtime } from "./runtime";
import type { Artifact, Task } from "../../packages/domain";

export function directorPrompt(context: unknown, message: string) {
  return `你是主控 Agent。用户口述要求，你评估影响范围后给出变更方案，不要只改提示词或只重出图。
画面和提示词由上游剧情、剧本和人物设定决定。没有先改设定或剧本时，禁止 revise_asset_prompt / regenerate_asset / revise_voice。
不要改动比 origin 更靠前且与本次无关的步骤。用户不必自己回到剧本页，方案里列入要改的上游即可。
origin 取最早必须改写的阶段：outline=故事概要，story=完整故事稿，plan=分集规划，script=单集剧本，shots=文字分镜。
返回 JSON：{"clear":boolean,"instruction":"一句话执行说明","explanation":"判断","origin":"story或plan或script等","change":[{"action":"revise_story|revise_look_registry|revise_series_plan|revise_episode_script|revise_shot_list|revise_asset_prompt|regenerate_asset|revise_voice","targetId":"资产或集ID可空","title":"给人看的条目"}],"invalidate":[{"title":"作废项","reason":"原因"}],"keep":[{"title":"保留项","reason":"原因"}]}。
若要求不清楚，clear=false，change 留空，instruction 写需确认的方案。
用户要求：${JSON.stringify(message)}
作品现状：${JSON.stringify(context)}`;
}

export function directorContext(runtime: Runtime, projectId: string) {
  const store = runtime.store;
  const approved = (stage: number, episode = 0) => {
    const task = store
      .tasks(projectId)
      .find((t) => t.stage === stage && (t.episode || 0) === episode);
    if (!task) return null;
    const art = store.one<Artifact>(
      "SELECT * FROM artifacts WHERE taskId=? AND revision=? AND status='approved' ORDER BY createdAt DESC LIMIT 1",
      task.id,
      task.revision,
    );
    return art?.content || null;
  };
  const story = structured(approved(7) || "", storySchema);
  const looksTask = store.tasks(projectId).find((t) => t.stage === 3);
  const looksArt = looksTask
    ? store.latestArtifact(looksTask.id)
    : null;
  const looks = looksArt ? mediaBundle(looksArt.content) : null;
  return {
    outline: approved(0)?.slice(0, 400) || "",
    bible: story?.bible || "",
    chapters: (story?.chapters || []).map((c) => ({
      id: c.id,
      title: c.title,
      excerpt: c.content.slice(0, 180),
    })),
    lookRegistry: story?.lookRegistry || store.lookRegistry(projectId) || null,
    episodes: store
      .tasks(projectId)
      .filter((t) => t.stage === 2)
      .map((t) => ({
        episode: t.episode,
        status: t.status,
        excerpt: (approved(2, t.episode || 1) || "").slice(0, 180),
      })),
    assets: ((looks?.data as any)?.assets || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      identity: a.identity,
    })),
  };
}

export function parseDirectorPlan(raw: unknown): ChangePlan {
  const plan = changePlanSchema.parse(raw);
  if (looksWithoutUpstream(plan))
    throw Error("不允许只改提示词或只重出图；须先改剧情、剧本或人物设定");
  assertChangePlan(plan);
  return plan;
}

export function storyRevisionContext(story: Story, item: ChangeItem) {
  const chapterId = item.targetId.match(/^CH\d+/i)?.[0];
  if (!chapterId) return story;
  return {
    type: "story-revision-context",
    bible: story.bible.slice(0, 1200),
    chapters: story.chapters.filter((chapter) => chapter.id === chapterId),
    lookEntities: (story.lookRegistry?.entities || []).filter((entity) => {
      if (item.targetId === entity.id || item.title.includes(entity.name))
        return true;
      return JSON.stringify(entity).includes(chapterId);
    }),
  };
}

export function mergeStoryRevision(current: Story, patch: unknown): Story {
  const full = storySchema.safeParse(patch);
  if (full.success) return full.data;
  const body = (patch && typeof patch === "object" ? patch : {}) as {
    bible?: string;
    chapters?: Story["chapters"];
    lookRegistry?: Story["lookRegistry"];
    lookEntities?: LookEntity[];
  };
  const chapters = current.chapters.map(
    (chapter) =>
      body.chapters?.find((next) => next.id === chapter.id) || chapter,
  );
  let lookRegistry = body.lookRegistry || current.lookRegistry;
  if (body.lookEntities?.length && lookRegistry) {
    lookRegistry = {
      ...lookRegistry,
      entities: lookRegistry.entities.map(
        (entity) =>
          body.lookEntities?.find((next) => next.id === entity.id) || entity,
      ),
    };
  }
  return storySchema.parse({
    ...current,
    bible: body.bible || current.bible,
    chapters,
    lookRegistry,
  });
}

function taskByStage(
  runtime: Runtime,
  projectId: string,
  stage: number,
  episode = 0,
) {
  const task = runtime.store
    .tasks(projectId)
    .find((t) => t.stage === stage && (t.episode || 0) === episode);
  if (!task) throw Error(`找不到阶段 ${stage}`);
  return task;
}

function episodeNumber(targetId: string) {
  const n = Number(String(targetId).replace(/^EP/i, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function reviseJson(
  runtime: Runtime,
  task: Task,
  signal: AbortSignal,
  prefix: string,
  prompt: string,
) {
  return parseResult(
    await runtime.call(
      task,
      crypto.randomUUID(),
      runtime.store.binding("主模型"),
      `${prefix}${prompt}`,
      signal,
    ),
  );
}

async function reviseText(
  runtime: Runtime,
  task: Task,
  signal: AbortSignal,
  prefix: string,
  prompt: string,
) {
  const raw = (
    await runtime.call(
      task,
      crypto.randomUUID(),
      runtime.store.binding("文本模型"),
      `${prefix}${prompt}`,
      signal,
    )
  ).trim();
  const wrapped = raw.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  return wrapped ? wrapped[1] : raw;
}

async function applyItem(
  runtime: Runtime,
  projectId: string,
  item: ChangeItem,
  plan: ChangePlan,
  signal: AbortSignal,
) {
  const store = runtime.store;
  if (item.action === "revise_story") {
    const task = taskByStage(runtime, projectId, 7);
    const current = storySchema.parse(
      JSON.parse(
        store.latestArtifact(task.id)?.content ||
          JSON.stringify({ type: "story", bible: "待补", chapters: [] }),
      ),
    );
    const next = mergeStoryRevision(
      current,
      await reviseJson(
        runtime,
        task,
        signal,
        "你是故事修订。",
        `用户已确认：${plan.instruction}。只改与此事实冲突的章节和设定，保留无关情节。可返回完整故事稿，或只返回 {"chapters":[改写后的目标章],"lookEntities":[改写后的外观实体]}。不要返回未改章节的全文。\n当前：${JSON.stringify(storyRevisionContext(current, item))}`,
      ),
    );
    store.replaceApprovedContent(task.id, JSON.stringify(next));
    return;
  }
  if (item.action === "revise_look_registry") {
    const task = taskByStage(runtime, projectId, 7);
    const current = storySchema.parse(
      JSON.parse(
        store.latestArtifact(task.id)?.content ||
          JSON.stringify({ type: "story", bible: "待补", chapters: [] }),
      ),
    );
    const entityId = parseLookAssetId(item.targetId).entityId;
    const entity =
      current.lookRegistry?.entities.find((entry) => entry.id === entityId) ||
      store.lookRegistry(projectId)?.entities.find((entry) => entry.id === entityId);
    if (!entity) throw Error(`外观实体不存在：${entityId}`);
    const nextEntity = lookEntitySchema.parse(
      await reviseJson(
        runtime,
        task,
        signal,
        "你是外观登记修订。",
        `用户已确认：${plan.instruction}。只改这一条外观实体，返回完整实体 JSON。\n当前：${JSON.stringify(entity)}`,
      ),
    );
    store.replaceApprovedContent(
      task.id,
      JSON.stringify(mergeStoryRevision(current, { lookEntities: [nextEntity] })),
    );
    return;
  }
  if (item.action === "revise_series_plan") {
    const task = taskByStage(runtime, projectId, 1);
    const current = store.latestArtifact(task.id)?.content || "";
    const next = await reviseJson(
      runtime,
      task,
      signal,
      "你是分集规划修订。",
      `用户已确认：${plan.instruction}。只改与此事实冲突的集摘要，返回完整 JSON 分集规划。\n当前：${current}`,
    );
    store.replaceApprovedContent(task.id, JSON.stringify(next));
    return;
  }
  if (item.action === "revise_episode_script") {
    const task = taskByStage(runtime, projectId, 2, episodeNumber(item.targetId));
    const current = store.latestArtifact(task.id)?.content || "";
    const next = await reviseText(
      runtime,
      task,
      signal,
      "你是剧本修订。",
      `用户已确认：${plan.instruction}。只改与此事实冲突的称呼和描写，保留 production-json 时间清单。返回完整剧本文本。\n当前：${current}`,
    );
    store.replaceApprovedContent(task.id, next);
    return;
  }
  if (item.action === "revise_shot_list") {
    const task = taskByStage(runtime, projectId, 8, episodeNumber(item.targetId));
    const current = store.latestArtifact(task.id)?.content || "";
    const next = await reviseJson(
      runtime,
      task,
      signal,
      "你是文字分镜修订。",
      `用户已确认：${plan.instruction}。只改与此事实冲突的镜头描述，返回完整 JSON。\n当前：${current}`,
    );
    store.replaceApprovedContent(task.id, JSON.stringify(next));
    return;
  }
  if (item.action === "revise_asset_prompt") {
    const task = taskByStage(runtime, projectId, 3);
    const artifact = store.latestArtifact(task.id);
    if (!artifact) throw Error("还没有可调整的定妆产物");
    const bundle = mediaBundle(artifact.content);
    const data = bundle?.data as any;
    const asset = data?.assets?.find((a: any) => a.id === item.targetId);
    if (!asset) throw Error(`资产不存在：${item.targetId}`);
    const result = (await reviseJson(
      runtime,
      task,
      signal,
      "你是定妆事实修订。",
      `人物设定已按用户确认更新。按新身份重写这一条 CONTENT，并更新 identity/state。允许改性别、年龄与身份。不要写入画风或渲染词。返回 JSON {"prompt":"CONTENT","promptFormat":"${asset.promptFormat || "character-content-v1"}","identity":"固定身份","state":"可复用形制"}。\n当前资产：${JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind, prompt: asset.prompt, identity: asset.identity, state: asset.state })}\n执行说明：${plan.instruction}`,
    )) as { prompt: string; promptFormat?: string; identity?: string; state?: string };
    asset.prompt = result.prompt;
    if (result.promptFormat) asset.promptFormat = result.promptFormat;
    if (result.identity) asset.identity = result.identity;
    if (result.state) asset.state = result.state;
    delete asset.promptDraft;
    delete asset.generationPrompt;
    delete asset.imageReview;
    store.db.run("UPDATE artifacts SET content=? WHERE id=?", [
      JSON.stringify({ type: "assets", data }, null, 2),
      artifact.id,
    ]);
    store.event(
      projectId,
      task.id,
      "director.revised",
      `${asset.name} 定妆提示词已按新设定改写。`,
    );
    return;
  }
  if (item.action === "regenerate_asset") {
    const task = taskByStage(runtime, projectId, 3);
    await runtime.pipeline.retryAsset(task, item.targetId, signal, true);
    const artifact = store.latestArtifact(task.id);
    if (!artifact) return;
    const bundle = mediaBundle(artifact.content);
    const data = bundle?.data as any;
    const asset = data?.assets?.find((a: any) => a.id === item.targetId);
    const nextId = asset?.candidates?.at(-1);
    if (asset && nextId) {
      asset.imageId = nextId;
      asset.selectedCandidateId = nextId;
      const spec = asset.candidateSpecs?.[nextId];
      if (spec) {
        asset.generationPrompt = spec.prompt;
        if (spec.contentPrompt) {
          asset.prompt = spec.contentPrompt;
          asset.promptFormat = spec.contentFormat;
        }
        asset.generationStyleKey = spec.styleKey;
        asset.generationStyleVersion = spec.styleVersion;
        asset.generationReferenceIds = spec.referenceIds;
      }
      delete asset.libraryId;
      store.db.run("UPDATE artifacts SET content=? WHERE id=?", [
        JSON.stringify({ type: "assets", data }, null, 2),
        artifact.id,
      ]);
      store.event(
        projectId,
        task.id,
        "director.revised",
        `${asset.name} 已按新设定重出定妆。`,
      );
    }
    return;
  }
  if (item.action === "revise_voice") {
    const task = taskByStage(runtime, projectId, 3);
    await runtime.pipeline.retryVoices(
      task,
      item.targetId || undefined,
      signal,
      true,
      true,
    );
  }
}

function invalidateMentionedMedia(
  runtime: Runtime,
  projectId: string,
  plan: ChangePlan,
) {
  if (!plan.invalidate.length) return;
  const names = plan.change
    .filter((item) => item.action === "regenerate_asset" || item.action === "revise_asset_prompt")
    .map((item) => item.targetId)
    .filter(Boolean);
  for (const task of runtime.store.tasks(projectId)) {
    if (![4, 5, 6].includes(task.stage)) continue;
    const art = runtime.store.latestArtifact(task.id);
    const text = art?.content || "";
    const hit =
      names.some((id) => text.includes(id)) ||
      /药童|女童/.test(text) ||
      plan.invalidate.some((item) => text.includes(item.title));
    if (!hit && names.length) continue;
    if (!hit) continue;
    runtime.store.db.run(
      "UPDATE tasks SET revision=revision+1,round=0,status='blocked',error='上游人物设定已修改，等待重新制作',updatedAt=? WHERE id=?",
      [new Date().toISOString(), task.id],
    );
  }
}

export async function applyChangePlan(
  runtime: Runtime,
  projectId: string,
  plan: ChangePlan,
  signal: AbortSignal,
) {
  assertChangePlan(plan);
  if (!plan.change.length) return;
  const looks = runtime.store.tasks(projectId).find((task) => task.stage === 3);
  const seen = new Set<string>();
  for (const item of sortChangeItems(plan.change)) {
    if (signal.aborted) throw Error("任务已中断");
    const key = `${item.action}:${item.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runtime.store.event(
      projectId,
      looks?.id || "",
      "director.progress",
      `正在改：${item.title}`,
    );
    await applyItem(runtime, projectId, item, plan, signal);
  }
  invalidateMentionedMedia(runtime, projectId, plan);
  runtime.store.event(
    projectId,
    "",
    "director.applied",
    formatChangePlan(plan),
  );
}

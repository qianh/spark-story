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
import { z } from "zod";
import {
  lookEntitySchema,
  parseLookAssetId,
  type LookEntity,
} from "../../packages/look-registry";
import { lookContentIssues } from "../../packages/visual-style";
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
宗门山门牌匾默认写该宗之名。故事没写匾额，不代表要再问用户，按宗名锁定外形即可。只有故事写明无匾、无字或字迹不可读时才不写宗名。
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

export function mergeStoryRevision(
  current: Story,
  patch: unknown,
  fallbackRegistry?: Story["lookRegistry"],
): Story {
  const full = storySchema.safeParse(patch);
  const body = (patch && typeof patch === "object" ? patch : {}) as {
    bible?: string;
    chapters?: Story["chapters"];
    lookRegistry?: Story["lookRegistry"];
    lookEntities?: LookEntity[];
  };
  const base = full.success
    ? {
        ...full.data,
        lookRegistry:
          full.data.lookRegistry ||
          current.lookRegistry ||
          fallbackRegistry,
      }
    : {
        ...current,
        bible: body.bible || current.bible,
        chapters: current.chapters.map(
          (chapter) =>
            body.chapters?.find((next) => next.id === chapter.id) || chapter,
        ),
        lookRegistry:
          body.lookRegistry || current.lookRegistry || fallbackRegistry,
      };
  let lookRegistry = base.lookRegistry;
  if (body.lookEntities?.length) {
    lookRegistry = lookRegistry
      ? {
          ...lookRegistry,
          entities: [
            ...lookRegistry.entities.map(
              (entity) =>
                body.lookEntities?.find((next) => next.id === entity.id) ||
                entity,
            ),
            ...body.lookEntities.filter(
              (entity) =>
                !lookRegistry!.entities.some((entry) => entry.id === entity.id),
            ),
          ],
        }
      : { type: "look-registry" as const, entities: body.lookEntities };
  }
  return storySchema.parse({ ...base, lookRegistry });
}

function spatialExcerpt(content: string, names: string[]) {
  const parts = content.split(/(?<=[。！？\n])/);
  const hit = parts.filter((part) =>
    names.some((name) => name && part.includes(name)),
  );
  const excerpt = (hit.length ? hit : parts.slice(0, 2)).join("");
  return (excerpt || content).slice(0, 400);
}

export function assetRevisionContext(
  story: Story | null | undefined,
  registry: Story["lookRegistry"] | undefined,
  asset: { id: string; name: string; identity?: string },
) {
  const entityId = parseLookAssetId(asset.id).entityId;
  const entities =
    registry?.entities || story?.lookRegistry?.entities || [];
  const entity =
    entities.find((entry) => entry.id === entityId) ||
    story?.lookRegistry?.entities.find((entry) => entry.id === entityId);
  const names = [asset.name, entity?.name, entityId].filter(Boolean) as string[];
  const chapters = (story?.chapters || [])
    .filter((chapter) => {
      const blob = `${chapter.title}${chapter.content}`;
      return names.some((name) => name && blob.includes(name));
    })
    .map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      excerpt: spatialExcerpt(chapter.content, names),
    }));
  const otherLooks = entities
    .filter((entry) => entry.id !== entityId)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      identity: (entry.variants || []).map((variant) => variant.identity).join("；"),
      form: (entry.variants || []).map((variant) => variant.form).join("；"),
    }));
  return { bible: story?.bible || "", lookEntity: entity || null, chapters, otherLooks };
}

export function lookFactsFromContext(
  asset: { id?: string; name?: string; identity?: string; state?: string },
  context: ReturnType<typeof assetRevisionContext>,
) {
  const variantId = asset.id ? parseLookAssetId(asset.id).variantId : "";
  const variant =
    context.lookEntity?.variants.find((entry) => entry.id === variantId) ||
    context.lookEntity?.variants.find((entry) => entry.name === asset.name) ||
    context.lookEntity?.variants[0];
  return {
    name: asset.name,
    identity: asset.identity || variant?.identity,
    state: asset.state,
    form: variant?.form,
    ageBand: variant && "ageBand" in variant ? String(variant.ageBand || "") : undefined,
    registry: JSON.stringify(context.lookEntity || ""),
    excerpts: context.chapters.map((chapter) => chapter.excerpt).join("\n"),
    otherLooks: context.otherLooks,
  };
}

export function seriesLookFactsPrompt() {
  return "定妆是这一条资产单独的全剧参考图，整部剧共用的参考图，不是某一集的画面，也不是把相关章节整场抄成一张图。范围是完整故事：先读全剧设定和这一条的外观登记，再从章节里参考写到该资产的句子，只抽取这一条自己可复用的身份与空间形制。章节只作参考，同场出现的其他地点、人物、道具凡已单独登记的，不要写入本条。设定里两处相邻（例如山门是通天古梧）只说明空间关系，不要把同场其他已登记资产合成一张。某一集的布置、仪式、天气不要写入（例如喜事红灯笼、丧事白布、冲洗冲不干净、雾散三日）。登记里可复用的痕迹要写（盐、灰、干羽、能停商队），某一集的过程不要写。只许翻译本条登记，不许改物件种类：符不是玉牌，匣不是圆盒，鸟不穿袍，树不是高台。设定未写年长或 ageBand=youth 时，Subject 必须写 youth，脸是青年；父兄式身量只写宽肩厚背的青年体量，禁止写成 father-brother、父亲、年长或中年。场景必须填写 Enclosure（室内封闭/室外开敞/通天树入云）和 Scale（人尺或整棵树入云）。Enclosure 和 Camera 必须跟本条空间同类：山门不是高台，剑崖不是高台，外门青石坪不是高台，只有问道台才写 open terrace。Time / weather 填默认可读日光，不要锁某一集的雨夜、雾散或干湿。不要丢掉这一条自己稳定出现的空间事实，例如年轮纹、空心如眼、本根神位、台高过人头。宗门山门牌匾写该宗之名，只此宗名，不写乱字；故事写明无匾或字迹不可读时才不写字。空眼写贴面空板与两口空井，禁止写 mask、面具或舞会面具，也不能写成瞳仁。只有登记写了空眼面具、空孔或枯井的角色才写贴面空板。枯萝是苦脸药师，袖中可藏空眼残片，脸不是空板。空瞳窥伺是洗掉五官的暗影，不要写成贴面空板。倒置炉鼎口朝下，不能画成正放高脚盏。铁尺不是学生尺，尺面是倒年轮而不是厘米刻度。角色同一身份只写一份 CONTENT；程序再出三张同尺寸全身（四分之三、正面、侧面），不要为角度另建资产。";
}

export const contentReviewPrefix = "你是定妆 CONTENT 核对。";
export const contentFixPrefix = "你是定妆 CONTENT 补写。";
export const contentReviewMaxRounds = 3;

export const contentReviewSchema = z.object({
  pass: z.boolean(),
  feedback: z.string().min(1),
  missing: z.array(z.string()).default([]),
  wrong: z.array(z.string()).default([]),
});

type ReviewableAsset = {
  id: string;
  name: string;
  kind: string;
  prompt: string;
  promptFormat?: string;
  identity?: string;
  state?: string;
};

export class AssetContentReviewError extends Error {
  constructor(
    public readonly assetName: string,
    public readonly prompt: string,
    public readonly promptFormat: string | undefined,
    public readonly review: z.infer<typeof contentReviewSchema> & { prompt: string },
  ) {
    super(`制作验收：${assetName} 的 CONTENT 核对未通过：${review.feedback}`);
    this.name = "AssetContentReviewError";
  }
}

type ContentReviewPrior = {
  feedback: string;
  missing?: string[];
  wrong?: string[];
};

export function assetContentReviewPrompt(
  asset: ReviewableAsset,
  context: ReturnType<typeof assetRevisionContext>,
  prior?: ContentReviewPrior,
) {
  const last = prior?.feedback
    ? `\n上次未通过：${JSON.stringify({ feedback: prior.feedback, missing: prior.missing || [], wrong: prior.wrong || [] })}。只核对待核 CONTENT 是否已按上次意见改完。`
    : "";
  return `${contentReviewPrefix}${seriesLookFactsPrompt()}只验收这一条 CONTENT 相对全剧设定、这一条外观登记是否完整、正确。相关章节只作参考，不要自己重写 CONTENT，不要改画风，不要发明故事里没有的装饰。
完整：这一条登记里该有的字段和自己的稳定形制都写了。
正确：室内外与人尺和这一条自己一致；没有把地点写成另一种空间类型；没有把章节整场抄进来；没有写入其他已登记资产的形制；没有写某一集的布置、仪式、天气。
不通过必须列出 missing 和 wrong，feedback 写可执行补写要求。
返回 JSON {"pass":boolean,"missing":["缺的稳定事实"],"wrong":["写错、整场抄写或其他资产"],"feedback":"说明"}。
当前资产：${JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind, promptFormat: asset.promptFormat, identity: asset.identity, state: asset.state })}
全剧设定：${JSON.stringify(context.bible)}
外观登记：${JSON.stringify(context.lookEntity)}
其他已登记资产（不要写入）：${JSON.stringify((context.otherLooks || []).map((look) => ({ name: look.name, kind: look.kind })))}
相关章节（只作参考）：${JSON.stringify(context.chapters)}${last}
待核 CONTENT：${asset.prompt}`;
}

export function assetContentFixPrompt(
  asset: ReviewableAsset,
  context: ReturnType<typeof assetRevisionContext>,
  review: z.infer<typeof contentReviewSchema>,
) {
  return `${contentFixPrefix}${seriesLookFactsPrompt()}按核对意见补写这一条 CONTENT，只补这一条自己的稳定形制，不把章节整场抄进来，不写入其他已登记资产，不写某一集布置，不发明装饰，不写入画风或渲染词。返回 JSON {"prompt":"CONTENT","promptFormat":"${asset.promptFormat || "visual-description-v1"}"}。
当前资产：${JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind, prompt: asset.prompt, promptFormat: asset.promptFormat, identity: asset.identity, state: asset.state })}
全剧设定：${JSON.stringify(context.bible)}
外观登记：${JSON.stringify(context.lookEntity)}
其他已登记资产（不要写入）：${JSON.stringify((context.otherLooks || []).map((look) => ({ name: look.name, kind: look.kind })))}
相关章节（只作参考）：${JSON.stringify(context.chapters)}
核对意见：${JSON.stringify(review)}`;
}

export async function reviewAssetContentWith(
  review: (prompt: string) => Promise<unknown>,
  asset: ReviewableAsset,
  context: ReturnType<typeof assetRevisionContext>,
  rewrite: (
    prompt: string,
  ) => Promise<{ prompt: string; promptFormat?: string }>,
  options?: { maxRounds?: number; prior?: ContentReviewPrior },
) {
  let current = asset.prompt;
  let format = asset.promptFormat;
  let last = contentReviewSchema.parse({
    pass: false,
    feedback: "尚未核对",
    missing: [],
    wrong: [],
  });
  const rounds = options?.maxRounds ?? contentReviewMaxRounds;
  for (let round = 0; round < rounds; round++) {
    try {
      last = contentReviewSchema.parse(
        await review(
          assetContentReviewPrompt(
            { ...asset, prompt: current, promptFormat: format },
            context,
            round === 0 ? options?.prior : last.pass ? undefined : last,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("制作验收")) throw error;
      throw Error("制作验收：CONTENT 核对没有返回有效结论");
    }
    const mechanical = lookContentIssues(
      asset.kind,
      current,
      lookFactsFromContext(asset, context),
    );
    if (mechanical.length)
      last = {
        pass: false,
        feedback: [mechanical.join("；"), last.feedback].filter(Boolean).join("；"),
        missing: last.missing,
        wrong: [...new Set([...(last.wrong || []), ...mechanical])],
      };
    if (last.pass)
      return {
        prompt: current,
        promptFormat: format,
        review: { ...last, prompt: current },
      };
    const fixed = await rewrite(
      assetContentFixPrompt(
        { ...asset, prompt: current, promptFormat: format },
        context,
        last,
      ),
    );
    if (!fixed?.prompt?.trim()) throw Error("CONTENT 补写未返回有效文本");
    current = fixed.prompt;
    if (fixed.promptFormat) format = fixed.promptFormat;
  }
  throw new AssetContentReviewError(asset.name, current, format, {
    ...last,
    prompt: current,
  });
}

export function assetPromptRevisionPrompt(
  asset: {
    id: string;
    name: string;
    kind: string;
    prompt: string;
    promptFormat?: string;
    identity?: string;
    state?: string;
  },
  instruction: string,
  context: ReturnType<typeof assetRevisionContext>,
) {
  return `人物设定已按用户确认更新。${seriesLookFactsPrompt()}按新身份和下面的外观登记重写这一条 CONTENT，并更新 identity/state。相关章节只作参考。允许改性别、年龄与身份。不要写入画风或渲染词，不要写入其他已登记资产。返回 JSON {"prompt":"CONTENT","promptFormat":"${asset.promptFormat || "character-content-v1"}","identity":"固定身份","state":"可复用形制"}。
当前资产：${JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind, prompt: asset.prompt, identity: asset.identity, state: asset.state })}
全剧设定：${JSON.stringify(context.bible)}
外观登记：${JSON.stringify(context.lookEntity)}
其他已登记资产（不要写入）：${JSON.stringify((context.otherLooks || []).map((look) => ({ name: look.name, kind: look.kind })))}
相关章节（只作参考）：${JSON.stringify(context.chapters)}
执行说明：${instruction}`;
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
    const restored = {
      ...current,
      lookRegistry:
        current.lookRegistry || store.lookRegistry(projectId) || undefined,
    };
    const next = mergeStoryRevision(
      restored,
      await reviseJson(
        runtime,
        task,
        signal,
        "你是故事修订。",
        `用户已确认：${plan.instruction}。只改与此事实冲突的章节和设定，保留无关情节。可返回完整故事稿，或只返回 {"chapters":[改写后的目标章],"lookEntities":[改写后的外观实体]}。不要返回未改章节的全文。漏掉外观登记时不要删除原登记。\n当前：${JSON.stringify(storyRevisionContext(restored, item))}`,
      ),
      store.lookRegistry(projectId),
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
    const restored = {
      ...current,
      lookRegistry:
        current.lookRegistry || store.lookRegistry(projectId) || undefined,
    };
    const entity =
      restored.lookRegistry?.entities.find((entry) => entry.id === entityId);
    if (!entity) throw Error(`外观实体不存在：${entityId}`);
    const source = assetRevisionContext(restored, restored.lookRegistry, {
      id: item.targetId || entity.id,
      name: entity.name,
    });
    const nextEntity = lookEntitySchema.parse(
      await reviseJson(
        runtime,
        task,
        signal,
        "你是外观登记修订。",
        `用户已确认：${plan.instruction}。只改这一条外观实体，返回完整实体 JSON。${seriesLookFactsPrompt()}\n当前：${JSON.stringify(entity)}\n全剧设定：${JSON.stringify(source.bible)}\n相关章节（从整部故事筛出）：${JSON.stringify(source.chapters)}`,
      ),
    );
    store.replaceApprovedContent(
      task.id,
      JSON.stringify(
        mergeStoryRevision(
          restored,
          { lookEntities: [nextEntity] },
          store.lookRegistry(projectId),
        ),
      ),
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
    const storyTask = store
      .tasks(projectId)
      .find((entry) => entry.stage === 7);
    const story = storyTask
      ? structured(store.latestArtifact(storyTask.id)?.content || "", storySchema)
      : null;
    const result = (await reviseJson(
      runtime,
      task,
      signal,
      "你是定妆事实修订。",
      assetPromptRevisionPrompt(
        asset,
        plan.instruction,
        assetRevisionContext(story, store.lookRegistry(projectId), asset),
      ),
    )) as { prompt: string; promptFormat?: string; identity?: string; state?: string };
    asset.prompt = result.prompt;
    if (result.promptFormat) asset.promptFormat = result.promptFormat;
    if (result.identity) asset.identity = result.identity;
    if (result.state) asset.state = result.state;
    delete asset.promptDraft;
    delete asset.generationPrompt;
    delete asset.imageReview;
    delete asset.contentReview;
    await runtime.pipeline.ensureReviewedAssetContent(task, asset, signal);
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

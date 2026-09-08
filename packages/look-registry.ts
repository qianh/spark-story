import { z } from "zod";

export const growthStages = [
  "child",
  "teen",
  "youth",
  "adult",
  "elder",
] as const;

export const lookVariantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["growth", "costume", "form"]),
  identity: z.string().min(1),
  form: z.string().min(1),
  source: z.string().min(1),
  ageBand: z.enum(growthStages).optional(),
  fromBeatId: z.string().optional(),
});

export const lookEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["character", "scene", "prop"]),
  variants: z.array(lookVariantSchema).min(1),
});

export const lookRegistrySchema = z.object({
  type: z.literal("look-registry"),
  entities: z.array(lookEntitySchema).min(1),
});

export type LookRegistry = z.infer<typeof lookRegistrySchema>;
export type LookEntity = z.infer<typeof lookEntitySchema>;
export type LookVariant = z.infer<typeof lookVariantSchema>;

export function lookAssetId(entityId: string, variantId: string) {
  return `${entityId}:${variantId}`;
}

export function parseLookAssetId(id: string) {
  const at = id.indexOf(":");
  if (at <= 0) return { entityId: id, variantId: "default" };
  return { entityId: id.slice(0, at), variantId: id.slice(at + 1) };
}

export function elderAllowed(entity: LookEntity, variant: LookVariant) {
  if (entity.kind !== "character") return false;
  return (
    variant.ageBand === "adult" ||
    variant.ageBand === "elder" ||
    /老者|长辈|老年|年迈|老妇/.test(`${variant.identity}${variant.source}`)
  );
}

export function locationLookKey(id: string) {
  if (!id.startsWith("LOC-")) return id;
  const parts = id.split("-");
  return parts.length >= 4 ? parts.slice(0, -1).join("-") : id;
}

export function collapseLocationLooks<
  T extends {
    id: string;
    kind: string;
    sourceAssetId?: string;
    sourceUsage?: "view" | "extract" | "variant";
  },
>(assets: T[]) {
  const groups = new Map<string, T[]>();
  for (const asset of assets) {
    if (asset.kind !== "scene") continue;
    const key = locationLookKey(asset.id);
    const list = groups.get(key);
    if (list) list.push(asset);
    else groups.set(key, [asset]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const master = list.reduce((a, b) => (a.id.length <= b.id.length ? a : b));
    for (const asset of list) {
      if (asset.id === master.id) continue;
      asset.sourceAssetId = master.id;
      asset.sourceUsage = "view";
    }
  }
  return assets;
}

export function lookSheetAssets<
  T extends { sourceUsage?: "view" | "extract" | "variant" },
>(assets: T[]) {
  return assets.filter((asset) => asset.sourceUsage !== "view");
}

export function attachShotLookViews<
  T extends {
    id: string;
    name: string;
    kind: string;
    prompt: string;
    identity: string;
    state: string;
    sourceAssetId?: string;
    sourceUsage?: "view" | "extract" | "variant";
  },
>(assets: T[], shotAssetIds: string[]): T[] {
  const have = new Set(assets.map((a) => a.id));
  const extra: T[] = [];
  for (const id of shotAssetIds) {
    if (have.has(id)) continue;
    const master =
      assets.find((a) => a.id === id) ||
      assets.find(
        (a) =>
          a.kind === "scene" &&
          (id.startsWith(a.id + "-") || locationLookKey(a.id) === locationLookKey(id)),
      );
    if (!master) continue;
    extra.push({
      ...master,
      id,
      name: master.name,
      sourceAssetId: master.id,
      sourceUsage: "view",
    });
    have.add(id);
  }
  return extra.length ? [...assets, ...extra] : assets;
}

export function lookRegistryAgentPrompt(bible: string, chaptersJson: string) {
  return `你是外观登记 Agent。从已确认全剧设定抽出可复用外观名册，不出图，不写镜头状态。每个实体至少一个变体。人物按成长阶段分变体（幼童/少年/青年；仅设定写明年长才用中年/老年），换装、破败形制另列变体。不要为门外、末阶、近景等视图建项。不要写入夜雨、熄灯、高烧、闭眼、出剑。每条 identity/form 必须带来源（设定原文或章节段落）。只返回 JSON {"type":"look-registry","entities":[{"id":"稳定ID","name":"名称","kind":"character或scene或prop","variants":[{"id":"youth或default或ruined","name":"变体名","kind":"growth或costume或form","identity":"固定身份","form":"可复用形制","source":"来源","ageBand":"child|teen|youth|adult|elder","fromBeatId":"可选段落ID"}]}]}。
全剧设定：${bible}
章节与段落：${chaptersJson}`;
}

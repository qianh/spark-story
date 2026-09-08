import { test, expect } from "bun:test";
import {
  attachShotLookViews,
  collapseLocationLooks,
  lookAssetId,
  lookRegistryAgentPrompt,
  lookRegistrySchema,
  lookSheetAssets,
  parseLookAssetId,
} from "../packages/look-registry";

test("同一地点多个分镜 ID 合成一张主定妆，其余当视图", () => {
  const assets = [
    {
      id: "LOC-QINGWU-SHANMEN-STAIRS",
      name: "山门石阶",
      kind: "scene",
      prompt: "山门",
      identity: "山门",
      state: "完好",
      sourceAssetId: undefined as string | undefined,
      sourceUsage: undefined as "view" | undefined,
    },
    {
      id: "LOC-QINGWU-SHANMEN-LASTSTEP",
      name: "山门末阶",
      kind: "scene",
      prompt: "末阶",
      identity: "山门",
      state: "完好",
      sourceAssetId: undefined as string | undefined,
      sourceUsage: undefined as "view" | undefined,
    },
    {
      id: "CHAR-SHEN-BUYAN",
      name: "沈不言",
      kind: "character",
      prompt: "人",
      identity: "人",
      state: "青年",
      sourceAssetId: undefined as string | undefined,
      sourceUsage: undefined as "view" | undefined,
    },
  ];
  collapseLocationLooks(assets);
  expect(assets[0].sourceUsage).toBeUndefined();
  expect(assets[1].sourceUsage).toBe("view");
  expect(assets[1].sourceAssetId).toBe("LOC-QINGWU-SHANMEN-STAIRS");
  const withOuter = attachShotLookViews(assets, [
    "LOC-QINGWU-SHANMEN-STAIRS",
    "LOC-QINGWU-SHANMEN-LASTSTEP",
    "LOC-QINGWU-SHANMEN-OUTER",
    "CHAR-SHEN-BUYAN",
  ]);
  expect(withOuter.some((a) => a.id === "LOC-QINGWU-SHANMEN-OUTER")).toBe(true);
  expect(
    withOuter.find((a) => a.id === "LOC-QINGWU-SHANMEN-OUTER")?.sourceUsage,
  ).toBe("view");
  const sheet = lookSheetAssets(withOuter);
  expect(sheet.filter((a) => a.kind === "scene")).toHaveLength(1);
  expect(sheet.some((a) => a.id === "LOC-QINGWU-SHANMEN-STAIRS")).toBe(true);
  expect(sheet.some((a) => a.id === "LOC-QINGWU-SHANMEN-LASTSTEP")).toBe(false);
  // 恢复时再次合并，后补的较短视图 ID 不应替换已有主定妆。
  collapseLocationLooks(withOuter);
  expect(lookSheetAssets(withOuter).find((a) => a.kind === "scene")?.id)
    .toBe("LOC-QINGWU-SHANMEN-STAIRS");
  expect(withOuter[0].sourceAssetId).toBeUndefined();
});

test("恢复已经形成循环的地点视图，保留人物产物并建立唯一主定妆", () => {
  const assets = [
    { id: "LOC-QINGWU-SHANMEN-STAIRS", kind: "scene", sourceAssetId: "LOC-QINGWU-SHANMEN-OUTER", sourceUsage: "view" as const },
    { id: "LOC-QINGWU-SHANMEN-OUTER", kind: "scene", sourceAssetId: "LOC-QINGWU-SHANMEN-STAIRS", sourceUsage: "view" as const },
    { id: "CHAR-SHEN", kind: "character", imageId: "saved-image" },
  ];
  collapseLocationLooks(assets);
  const roots = lookSheetAssets(assets).filter(a => a.kind === "scene");
  expect(roots).toHaveLength(1);
  expect(roots[0].sourceAssetId).toBeUndefined();
  expect(assets.filter(a => a.sourceUsage === "view").every(a => a.sourceAssetId === roots[0].id)).toBe(true);
  expect(assets[2].imageId).toBe("saved-image");
  const saved = JSON.stringify(assets);
  collapseLocationLooks(assets);
  expect(JSON.stringify(assets)).toBe(saved);
});

test("外观登记只抽实体和变体，不把视图当资产", () => {
  const prompt = lookRegistryAgentPrompt("青梧宗。", "[]");
  expect(prompt).toContain("不要为门外、末阶");
  expect(prompt).toContain("不要写入夜雨");
  const parsed = lookRegistrySchema.parse({
    type: "look-registry",
    entities: [
      {
        id: "gate",
        name: "山门",
        kind: "scene",
        variants: [
          {
            id: "default",
            name: "完好",
            kind: "form",
            identity: "青梧山门",
            form: "白天干燥石阶与门柱",
            source: "青梧宗。",
          },
          {
            id: "ruined",
            name: "破败",
            kind: "form",
            identity: "青梧山门",
            form: "崩裂门柱",
            source: "后文山门已毁",
          },
        ],
      },
    ],
  });
  expect(lookAssetId("gate", "ruined")).toBe("gate:ruined");
  expect(parseLookAssetId("gate:ruined")).toEqual({
    entityId: "gate",
    variantId: "ruined",
  });
  expect(parsed.entities[0].variants).toHaveLength(2);
});

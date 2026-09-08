import { test, expect } from "bun:test";
import {
  attachShotLookViews,
  collapseLocationLooks,
  lookAssetId,
  lookRegistryAgentPrompt,
  lookRegistrySchema,
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

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  assetVisualPrompt,
  donghuaStyleVersion,
  lookBriefIssues,
  lookContentIssues,
  repairLookPrompt,
  selectedVisualStyleRule,
  sharedStyleDna,
  xianxiaWorldDna,
} from "../packages/visual-style";

const dbPath = `${import.meta.dir}/../.spark-story/state.sqlite`;
const projectId = "b34e6012-b7b2-47f8-bba3-3eb353863a7a";
const lookTaskId = "f0df3874-d830-4407-9dd9-bd3053aa4a44";

function matchVariant(
  asset: { id: string; name: string },
  entities: Array<{
    id: string;
    name: string;
    kind: string;
    variants?: { id: string; name: string; identity?: string; form?: string }[];
  }>,
) {
  for (const entity of entities) {
    const variant = (entity.variants || []).find(
      (entry) => entry.name === asset.name || `${entity.id}:${entry.id}` === asset.id,
    );
    if (variant) return { entity, variant };
    if (entity.name === asset.name) return { entity, variant: entity.variants?.[0] };
  }
  return { entity: undefined, variant: undefined };
}

test("未按登记修复的走样稿，形制闸能抓住改物件种类", () => {
  expect(
    lookContentIssues("prop", "Item: jade token\nForm: oval jade plaque with silk ribbon", {
      name: "年轮拓印符",
      identity: "青梧真人掌中灵脉符。古梧年轮拓印。",
      form: "符面是古梧的年轮拓印。",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("玉牌")]));
  expect(
    lookContentIssues("prop", "Item: unopened elixir box\nForm: round box, lacquered", {
      name: "未开的定相匣",
      identity: "顾行舟未用的定相秘丹及其匣。",
      form: "未打开的丹匣，可收袖中。",
    }),
  ).toEqual(expect.arrayContaining([expect.stringContaining("圆盒")]));
  expect(
    lookContentIssues(
      "scene",
      "Place: tongtian ancient wutong\nEnclosure: outdoor open terrace\nCamera: wide open terrace",
      {
        name: "通天古梧",
        identity: "冠看不见顶，根看不见底。",
        form: "通天巨梧，根冠入云海。",
      },
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining("高台")]));
});

(existsSync(dbPath) ? test : test.skip)(
  "按登记修复后，27 条真实稿出图前门可过，且锁定作品已选仙侠风",
  () => {
    const db = new Database(dbPath, { readonly: true });
    const settings = JSON.parse(
      (db.query("SELECT data FROM project_settings WHERE projectId=?").get(projectId) as { data: string })
        .data,
    );
    const latest = db.query(
      "SELECT content FROM artifacts WHERE taskId=? ORDER BY createdAt DESC LIMIT 1",
    ).get(lookTaskId) as { content: string } | null;
    db.close();
    if (!latest?.content) return;
    const assets = JSON.parse(latest.content).data.assets as Array<{
      id: string;
      name: string;
      kind: string;
      prompt: string;
      promptFormat?: string;
      identity: string;
      state: string;
    }>;
    expect(assets).toHaveLength(27);
    const entities = settings.lookRegistry.entities as Array<{
      id: string;
      name: string;
      kind: string;
      variants?: { id: string; name: string; identity?: string; form?: string }[];
    }>;
    const locked = settings.visual as {
      id?: string;
      version?: string;
      prompt?: string;
      characterModule?: string;
      propModule?: string;
      sceneModule?: string;
      referenceImageId?: string;
    };
    // 作品画风必须是现行感觉稿（雾山不是默认背景），并挂了参考图
    expect(locked.version).toBe(donghuaStyleVersion);
    expect(locked.prompt).toBe(sharedStyleDna);
    expect(locked.referenceImageId).toBeTruthy();
    const style = {
      id: locked.id || "donghua3d",
      name: "三维仙侠国漫",
      prompt: locked.prompt || "",
      version: locked.version,
      characterModule: locked.characterModule,
      propModule: locked.propModule,
      sceneModule: locked.sceneModule,
    };
    const failed: string[] = [];
    for (const asset of assets) {
      const { variant } = matchVariant(asset, entities);
      const facts = {
        name: asset.name,
        identity: asset.identity || variant?.identity,
        state: asset.state,
        form: variant?.form,
        otherLooks: entities
          .filter((entity) => entity.name !== asset.name && !entity.variants?.some((entry) => entry.name === asset.name))
          .map((entity) => ({
            name: entity.name,
            kind: entity.kind,
            identity: entity.variants?.[0]?.identity,
            form: entity.variants?.[0]?.form,
          })),
      };
      const repaired = repairLookPrompt(asset.kind, asset.prompt, facts);
      const issues = lookContentIssues(asset.kind, repaired, facts);
      let compiled = "";
      let brief: string[] = [];
      let compileError = "";
      try {
        compiled = assetVisualPrompt(style, { ...asset, prompt: repaired }, [], { facts });
        brief = lookBriefIssues(asset.kind, compiled, facts);
        if (!compiled.startsWith(asset.kind === "character" ? sharedStyleDna : xianxiaWorldDna))
          brief.push("未以作品选定的仙侠感觉稿开头");
        if (/mist-wrapped jagged peaks|behind every subject/i.test(compiled))
          brief.push("编译仍把雾山写成默认背景");
        if (/porcelain-pale|luxury immortal-drama character sheet|readable studio key|taupe-gray|Chinese 3D xianxia donghua from one same series/i.test(compiled))
          brief.push("编译混入了旧版画风");
        if (/Do not add gauze|Do not add motifs|Keep a single-layer xianxia robe|no separate inner color/i.test(compiled))
          brief.push("编译仍在用禁令剥掉画风");
        if (!/Style feel: the same painter/.test(compiled)) brief.push("正文缺少 Style feel");
        if (/\b(?:like|as if|as though)\s+\w+/i.test(compiled.split("Face:")[1]?.split("\n")[0] || ""))
          brief.push("Face 仍在直译比喻");
        if (!compiled.endsWith(selectedVisualStyleRule(style))) brief.push("未以画风优先级结尾");
        const stored = (asset as { generationPrompt?: string }).generationPrompt || "";
        if (stored) {
          if (/taupe-gray|Do not add gauze|Chinese 3D xianxia donghua from one same series/i.test(stored))
            brief.push("已存生图词混入旧版");
        }
        if (asset.name === "古梧青鸟" && /xianxia robe construction|Keep a single-layer xianxia robe/.test(compiled))
          brief.push("青鸟编译仍在穿袍");
        if (asset.name === "通天古梧" && /Architecture: keep this an open terrace/.test(compiled))
          brief.push("古梧编译仍是高台");
        if (asset.name === "年轮拓印符" && /jade token/i.test(compiled))
          brief.push("符编译仍是玉牌");
        if (asset.name === "未开的定相匣" && /round box/i.test(compiled))
          brief.push("匣编译仍是圆盒");
        if (asset.name === "取相使·苦哀" && /blank plate flush to the face/i.test(`${asset.prompt}\n${compiled}`))
          brief.push("苦哀被写成贴面空板");
        if (asset.name === "空瞳窥伺" && /blank plate flush to the face/i.test(asset.prompt))
          brief.push("空瞳被写成贴面空板");
        if (asset.name === "空瞳窥伺" && /silhouette sheet|fully opaque silhouette/.test(compiled))
          brief.push("空瞳仍是剪影铜像");
        if ((asset.name === "年轮大殿" || asset.name === "药寮") && /mist-wrapped jagged peaks|soft overcast daylight from above/.test(compiled))
          brief.push("室内景仍在用露天天光和山峦");
        if (asset.name === "年轮大殿" && /Time \/ weather: overcast day|skylight|sky well|ridge gap|light shaft/.test(compiled))
          brief.push("正殿仍是露天天光或漏顶");
        if (asset.name === "年轮大殿" && !/closed far wall|distant closed end wall/.test(compiled))
          brief.push("正殿没有封死尽头墙");
        if (asset.name === "年轮大殿" && (!/palace-nave|金柱|columns thicker than a standing person/.test(compiled) || !/shrine-canopy|shrine dais|神位/.test(compiled)))
          brief.push("正殿没有宗门主殿尺度");
        if (asset.name === "药寮" && /Time \/ weather: overcast day|wet mist|skylight|sky well|ridge gap|light shaft/.test(compiled))
          brief.push("药寮写成了露天或漏顶");
        if (asset.name === "药寮" && !/boarded timber ceiling|solid opaque ceiling|continuous timber ceiling|closed medicine room/.test(compiled))
          brief.push("药寮没有封死屋顶");
        if (asset.name === "药寮" && /晚晴|labeled/.test(compiled))
          brief.push("药寮编译仍有柜字");
        if (asset.name === "药寮" && !/lacquered/.test(compiled))
          brief.push("药寮没有跟大殿同一套材质语言");
        if (asset.kind === "character" && asset.name !== "古梧青鸟" && !/Look angle: three-quarter|isolated front|isolated left profile|one full-body three-quarter/.test(compiled))
          brief.push("人物定妆不是三视图");
        if (asset.name === "年轮大殿" && /human-scale year-ring|far wall fills the end of the frame|Camera inside a roofed room/.test(compiled))
          brief.push("正殿被写成小房间");
        if (asset.name === "年轮大殿" && !/year-ring|wutong|金柱|lacquered/.test(compiled))
          brief.push("正殿没有仙侠宗门主殿形制");
        if (asset.name === "年轮大殿" && !/shrine-canopy|shrine dais|神位|dougong|藻井|caisson/.test(compiled))
          brief.push("正殿没有神龛形制");
        if (asset.name === "倒置万相炉" && !/three legs|ding-furnace/.test(compiled))
          brief.push("炉看不出鼎");
      } catch (error) {
        compileError = error instanceof Error ? error.message : String(error);
      }
      if (issues.length || brief.length || compileError)
        failed.push(
          `${asset.name}: ${[...issues, ...brief, compileError].filter(Boolean).join("；")}`,
        );
    }
    expect(failed).toEqual([]);
  },
);

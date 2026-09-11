import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  mediaGenerationProgress,
  plannedMediaItems,
  type MediaJob,
} from "../packages/media";
import {
  ArtifactLibrary,
  AssetTextDialog,
  BundleView,
  MediaGenerationProgress,
  MediaLibrary,
  MediaPreview,
} from "../apps/web/MediaStudio";

const jobs = (rows: Partial<MediaJob>[]): MediaJob[] =>
  rows.map((j, i) => ({
    id: j.id || "job-" + i,
    projectId: "p",
    taskId: "t",
    revision: 1,
    kind: "image",
    agent: "角色与关键帧 Agent",
    prompt: "定妆",
    inputs: "[]",
    options: "{}",
    connection: "{}",
    status: "queued",
    remoteId: "",
    outputId: "",
    error: "",
    costId: "",
    operationKey: "",
    createdAt: "",
    updatedAt: "",
    ...j,
  })) as MediaJob[];

test("定妆方案立刻拆成可预览条目，已生成文件计入完成数", () => {
  const bundle = {
    type: "assets",
    data: {
      summary: "本集定妆",
      assets: [
        { id: "hero", name: "林小雨", kind: "character", imageId: "img-1" },
        { id: "alley", name: "雨巷", kind: "scene" },
      ],
      voices: [
        {
          character: "林小雨",
          voice: "alloy",
          sampleText: "你好",
          audioId: "a1",
        },
        { character: "林小雨", voice: "nova", sampleText: "你好" },
      ],
    },
  };
  expect(plannedMediaItems(bundle).map((i) => i.name)).toEqual([
    "林小雨",
    "雨巷",
    "林小雨 试听",
    "林小雨 试听",
  ]);
  const progress = mediaGenerationProgress({
    bundle,
    jobs: jobs([{ status: "polling", prompt: "雨巷夜色" }]),
    running: true,
  });
  expect(progress.phase).toBe("generating");
  expect(progress.done).toBe(2);
  expect(progress.total).toBe(4);
  expect(progress.label).toContain("2 / 4");
  expect(progress.current?.status).toBe("polling");
});

test("无需试听不计入待生成产物，审核期间不误报声音处理中", () => {
  const bundle = {
    type: "assets",
    data: {
      summary: "定妆",
      assets: [],
      voices: [
        { character: "沈不言", status: "ready", voice: "VoiceDesign", audioId: "a1", voicePortrait: {} },
        { character: "病弱幼女", status: "not_required" },
        { character: "窥伺影", status: "not_required" },
      ],
    },
  };
  const progress = mediaGenerationProgress({ bundle, jobs: [], running: false });
  expect(progress.total).toBe(1);
  expect(progress.done).toBe(1);
  expect(progress.phase).toBe("complete");
  const html = renderToStaticMarkup(
    <BundleView content={JSON.stringify(bundle)} files={[]} busy={true} onSave={() => {}} onRetryVoices={() => {}} />,
  );
  expect(html).toContain("暂不需要生成，后续按需补齐");
  expect(html).toContain("当前批次再听一条");
  expect(html).not.toContain("处理中");
  bundle.data.voices.push({ character: "待选声角色", status: "needs_voice" });
  const pending = mediaGenerationProgress({ bundle, jobs: [], running: false });
  expect(pending.total).toBe(2);
  expect(pending.phase).toBe("generating");
});

test("尚无方案时只报告规划中，不编造完成百分比", () => {
  const progress = mediaGenerationProgress({
    bundle: null,
    jobs: [],
    running: true,
  });
  expect(progress.phase).toBe("planning");
  expect(progress.done).toBe(0);
  expect(progress.total).toBe(0);
  expect(progress.label).toContain("规划");
  expect(progress.label).not.toMatch(/%/);
});

test("进度条展示已落地数量、当前供应商状态和待生成项", () => {
  const html = renderToStaticMarkup(
    <MediaGenerationProgress
      progress={mediaGenerationProgress({
        bundle: {
          type: "assets",
          data: {
            assets: [
              { id: "hero", name: "林小雨", imageId: "img-1" },
              { id: "alley", name: "雨巷" },
            ],
            voices: [],
          },
        },
        jobs: jobs([{ status: "polling", prompt: "雨巷夜色，青石反光" }]),
        running: true,
      })}
    />,
  );
  expect(html).toContain("产物生成进度");
  expect(html).toContain("1 / 2");
  expect(html).toContain("供应商生成中");
  expect(html).toContain("林小雨");
  expect(html).toContain("雨巷");
  expect(html).toContain('class="media-generation-track"');
  expect(html).toMatch(/<li[^>]*>[\s\S]*林小雨[\s\S]*<\/li>/);
  expect(html).not.toContain("media-generation-items");
});

test("进度条不把同一地点的视图算进产物格", () => {
  const progress = mediaGenerationProgress({
    bundle: {
      type: "assets",
      data: {
        assets: [
          { id: "LOC-GATE", name: "青梧宗山门", kind: "scene" },
          {
            id: "LOC-GATE-LAST",
            name: "青梧宗山门",
            kind: "scene",
            sourceUsage: "view",
          },
          {
            id: "LOC-GATE-OUTER",
            name: "青梧宗山门",
            kind: "scene",
            sourceUsage: "view",
          },
        ],
        voices: [],
      },
    },
    jobs: [],
    running: true,
  });
  expect(progress.total).toBe(1);
  expect(progress.items.map((i) => i.id)).toEqual(["LOC-GATE"]);
  expect(progress.label).toContain("0 / 1");
});

test("规划阶段在预览上方说明正在整理方案，空预览不再假装没有工作", () => {
  const html = renderToStaticMarkup(
    <MediaGenerationProgress
      progress={mediaGenerationProgress({
        bundle: null,
        jobs: [],
        running: true,
      })}
    />,
  );
  expect(html).toContain("规划");
  expect(html).toContain("方案确定后");
});

test("部分定妆图已完成时预览直接显示图片，未完成项保留占位", () => {
  const html = renderToStaticMarkup(
    <BundleView
      content={JSON.stringify({
        type: "assets",
        data: {
          summary: "生成中的定妆",
          assets: [
            {
              id: "hero",
              name: "林小雨",
              kind: "character",
              prompt: "青衫少女",
              imageId: "img-1",
            },
            {
              id: "alley",
              name: "雨巷",
              kind: "scene",
              prompt: "青石巷",
            },
          ],
          voices: [],
        },
      })}
      files={[
        {
          id: "img-1",
          projectId: "p",
          taskId: "t",
          revision: 1,
          kind: "image",
          name: "林小雨.png",
          path: "img-1.png",
          mime: "image/png",
          metadata: "{}",
          createdAt: "",
        },
      ]}
      busy={false}
      onSave={() => {}}
    />,
  );
  expect(html).toContain("林小雨.png");
  expect(html).toContain('alt="林小雨.png"');
  expect(html).toContain("雨巷");
  expect(html).toContain("等待实际产物");
});

test("媒体库提供勾选和批量删除", () => {
  const html = renderToStaticMarkup(
    <MediaLibrary
      files={[
        {
          id: "img-1",
          projectId: "p",
          taskId: "t",
          revision: 46,
          kind: "image",
          name: "山门.png",
          path: "img-1.png",
          mime: "image/png",
          metadata: "{}",
          createdAt: "",
        },
      ]}
      task={{
        id: "t",
        projectId: "p",
        stage: 3,
        title: "定妆与资产",
        role: "角色与资产 Agent",
        status: "paused",
        revision: 47,
        round: 0,
        instruction: "",
        error: "",
        updatedAt: "",
      }}
      act={() => {}}
      onUpdated={() => {}}
    />,
  );
  expect(html).toContain("批量删除");
  expect(html).toContain("全选");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("选择 山门.png");
});

test("资产库产物记录提供勾选和批量删除", () => {
  const html = renderToStaticMarkup(
    <ArtifactLibrary
      artifacts={[
        {
          id: "art-1",
          taskId: "t",
          revision: 52,
          content: '{"type":"assets","data":{"summary":"定妆"}}',
          status: "candidate",
          createdAt: "",
        },
      ]}
      tasks={[
        {
          id: "t",
          projectId: "p",
          stage: 3,
          title: "定妆与资产",
          role: "角色与资产 Agent",
          status: "paused",
          revision: 55,
          round: 0,
          instruction: "",
          error: "",
          updatedAt: "",
        },
      ]}
      projectId="p"
      act={() => {}}
      onUpdated={() => {}}
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("产物记录");
  expect(html).toContain("批量删除");
  expect(html).toContain("全选");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("选择 定妆与资产 修订 52");
  expect(html).toContain("候选版");
});

test("定妆卡片提供单张重新生成，不进入整体编辑", () => {
  const html = renderToStaticMarkup(
    <BundleView
      content={JSON.stringify({
        type: "assets",
        data: {
          summary: "定妆",
          assets: [
            {
              id: "hero",
              name: "沈不言",
              kind: "character",
              prompt: "青衫",
              imageId: "img-1",
            },
          ],
          voices: [],
        },
      })}
      files={[
        {
          id: "img-1",
          projectId: "p",
          taskId: "t",
          revision: 1,
          kind: "image",
          name: "沈不言.png",
          path: "img-1.png",
          mime: "image/png",
          metadata: "{}",
          createdAt: "",
        },
      ]}
      busy={false}
      onSave={() => {}}
      onRetryAsset={() => {}}
    />,
  );
  expect(html).toContain("再抽一张");
  expect(html).toContain("沈不言");
});

test("定妆网格不展示同一地点的视图卡片", () => {
  const html = renderToStaticMarkup(
    <BundleView
      content={JSON.stringify({
        type: "assets",
        data: {
          summary: "定妆",
          assets: [
            {
              id: "LOC-QINGWU-SHANMEN-STAIRS",
              name: "青梧宗山门",
              kind: "scene",
              prompt: "主定妆",
            },
            {
              id: "LOC-QINGWU-SHANMEN-LASTSTEP",
              name: "青梧宗山门",
              kind: "scene",
              prompt: "末阶",
              sourceUsage: "view",
            },
            {
              id: "LOC-QINGWU-SHANMEN-OUTER",
              name: "青梧宗山门",
              kind: "scene",
              prompt: "门外",
              sourceUsage: "view",
            },
          ],
          voices: [],
        },
      })}
      files={[]}
      busy={false}
      onSave={() => {}}
    />,
  );
  expect(html.split("青梧宗山门").length - 1).toBe(1);
});

test("定妆提示词默认收起，需点开查看", () => {
  const prompt = "竖屏9:16单人全身定妆，完整可见从头顶到靴底。";
  const html = renderToStaticMarkup(
    <BundleView
      content={JSON.stringify({
        type: "assets",
        data: {
          summary: "定妆",
          assets: [
            {
              id: "hero",
              name: "沈不言",
              kind: "character",
              prompt,
              imageId: "img-1",
            },
          ],
          voices: [],
        },
      })}
      files={[]}
      busy={false}
      onSave={() => {}}
    />,
  );
  expect(html).toContain("查看提示词");
  expect(html).not.toContain("<details");
  expect(html).not.toContain("<summary>查看提示词</summary>");
  expect(html).not.toContain(prompt);
});

test("声音试听展示声音卡、试听稿、文件时长和再听一条", () => {
  const html = renderToStaticMarkup(
    <BundleView
      content={JSON.stringify({
        type: "assets",
        data: {
          summary: "定妆",
          assets: [
            {
              id: "hero",
              name: "沈不言",
              kind: "character",
              prompt: "定妆",
            },
          ],
          voices: [
            {
              character: "沈不言",
              voice: "VoiceDesign",
              sampleText:
                "我只问她还活着没有。先把人带离石阶，再谈其余。剑还在腰侧，这一夜不许任何人靠近。青梧的规矩不是拿来吓孩子的，是拿来护人的。山门空着，谁来都要先过我这一关，没有例外。",
              instructions:
                "青年男性，中音，音色清冷、偏薄、不浑厚。偏年轻、有青春感。语速中，吐字清楚。标准普通话，无方言。情绪底色克制、冷、不煽情。不要广告腔、卖萌、朗诵、读画面。",
              castingNote:
                "沿用已确认声线。再生成是同一方向的抽样，不能当声音克隆。",
              status: "ready",
              audioId: "aud-1",
              voicePortrait: {
                gender: "male",
                ageBand: "youth",
                pitch: "mid",
                timbre: "清冷、偏薄、不浑厚",
                pace: "medium",
                accent: "标准普通话，无方言",
                baselineEmotion: "克制、冷、不煽情",
                avoid: ["广告腔", "卖萌", "朗诵", "读画面"],
              },
            },
          ],
        },
      })}
      files={[
        {
          id: "aud-1",
          projectId: "p",
          taskId: "t",
          revision: 1,
          kind: "audio",
          name: "试听.wav",
          path: "a.wav",
          mime: "audio/wav",
          metadata: JSON.stringify({ duration: 8.24, hasAudio: true }),
          createdAt: "",
        },
      ]}
      busy={false}
      onSave={() => {}}
      onRetryVoices={() => {}}
    />,
  );
  expect(html).toContain("青年男性，中音");
  expect(html).toContain("山门空着");
  expect(html).toContain("沿用已确认声线");
  expect(html).toContain("8.2 秒");
  expect(html).toContain("再听一条");
  expect(html).toContain("重新生成声音画像");
  expect(html).not.toContain("重新生成此角色");
});

test("图片缩略图可放大预览，下载仍可用", () => {
  const html = renderToStaticMarkup(
    <MediaPreview
      id="img-1"
      files={[
        {
          id: "img-1",
          projectId: "p",
          taskId: "t",
          revision: 1,
          kind: "image",
          name: "沈不言.png",
          path: "img-1.png",
          mime: "image/png",
          metadata: "{}",
          createdAt: "",
        },
      ]}
    />,
  );
  expect(html).toContain("放大预览 沈不言.png");
  expect(html).toContain("下载 沈不言.png");
  expect(html).toContain('alt="沈不言.png"');
});

test("旧试听没有声音卡时，声音区可单独生成画像，不重做定妆图", () => {
  const html = renderToStaticMarkup(
    <BundleView
      content={JSON.stringify({
        type: "assets",
        data: {
          summary: "定妆",
          assets: [
            {
              id: "hero",
              name: "沈不言",
              kind: "character",
              prompt: "定妆",
              imageId: "img-1",
            },
          ],
          voices: [
            {
              character: "沈不言",
              voice: "VoiceDesign",
              sampleText: "还活着。",
              instructions: "角色设定：湿袍",
              status: "ready",
              audioId: "aud-1",
            },
          ],
        },
      })}
      files={[]}
      busy={false}
      onSave={() => {}}
      onRetryVoices={() => {}}
    />,
  );
  expect(html).toContain("生成声音画像");
  expect(html).toContain("当前批次生成声音画像");
  expect(html).not.toContain("再听一条");
});

test("全剧其他角色待配音不阻塞当前批次进度，声音卡仍保留展示", () => {
  const bundle = { type: "assets", data: {
    summary: "全剧", voiceBatchAssetIds: ["shen:youth"],
    assets: [{ id: "shen:youth", name: "沈不言", kind: "character", imageId: "shen-image" }, { id: "su:child", name: "苏晚晴", kind: "character", imageId: "su-image", growthStage: "child" }],
    voices: [{ character: "沈不言", status: "ready", audioId: "shen-audio" }, { character: "苏晚晴", growthStage: "child", status: "needs_voice" }],
  } };
  expect(mediaGenerationProgress({ bundle, jobs: [], running: false }).phase).toBe("complete");
  const html = renderToStaticMarkup(<BundleView content={JSON.stringify(bundle)} files={[]} busy={false} onSave={() => {}} />);
  expect(html).toContain("苏晚晴");
  expect(html).toContain("后续按需补齐");
  expect(bundle.data.voices).toHaveLength(2);
});

test("定妆卡片显示审核锁，不通过原因点开查看", () => {
  const html = renderToStaticMarkup(<BundleView files={[]} onSave={() => {}} busy={false} content={JSON.stringify({
    type: "assets", data: { summary: "逐张审核", voices: [], assets: [
      { id: "a", name: "已通过玉牌", kind: "prop", prompt: "玉牌", imageId: "img-a", generationPrompt: "玉牌", imageReview: { imageId: "img-a", prompt: "玉牌", pass: true, feedback: "通过" } },
      { id: "b", name: "待修正玉牌", kind: "prop", prompt: "玉牌", imageId: "img-b", generationPrompt: "玉牌", imageReview: { imageId: "img-b", prompt: "玉牌", pass: false, feedback: "边缘被裁切" } },
    ] },
  })} />);
  expect(html).toContain("已通过 · 已锁定");
  expect(html).toContain("待自动重试");
  expect(html).toContain("不通过原因");
  expect(html).not.toContain("待自动重试：边缘被裁切");
  expect(html).not.toContain("边缘被裁切");
  expect(html).toContain("1 / 2");
});

test("不通过原因与提示词弹框展示正文", () => {
  const review = renderToStaticMarkup(
    <AssetTextDialog title="不通过原因" onClose={() => {}}>
      <p>边缘被裁切</p>
    </AssetTextDialog>,
  );
  expect(review).toContain('role="dialog"');
  expect(review).toContain("不通过原因");
  expect(review).toContain("边缘被裁切");
  expect(review).toContain("关闭");
  const prompt = renderToStaticMarkup(
    <AssetTextDialog title="提示词" onClose={() => {}}>
      <strong>本图生成时的画风与要求</strong>
      <p>竖屏9:16单人全身定妆</p>
      <strong>资产内容设定</strong>
      <p>沈不言青年定妆</p>
    </AssetTextDialog>,
  );
  expect(prompt).toContain("提示词");
  expect(prompt).toContain("本图生成时的画风与要求");
  expect(prompt).toContain("竖屏9:16单人全身定妆");
});

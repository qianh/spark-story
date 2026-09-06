import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  mediaGenerationProgress,
  plannedMediaItems,
  type MediaJob,
} from "../packages/media";
import { BundleView, MediaGenerationProgress } from "../apps/web/MediaStudio";

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
  expect(html).toContain("重新生成");
  expect(html).toContain("沈不言");
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
  expect(html).toContain("<details");
  expect(html).toContain("<summary>查看提示词</summary>");
  expect(html).toContain(prompt);
});

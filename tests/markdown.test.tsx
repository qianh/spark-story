import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../apps/web/MarkdownContent";
import { timingFixture } from "./fixtures/timing";
import { outlineFixture, storyFixture } from "./fixtures/series";
test("时间清单显示为可读节拍表，而非原始 JSON", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent content={"# 剧本" + timingFixture()} />,
  );
  expect(html).toContain("节拍时间表");
  expect(html).toContain("0～45 秒");
  expect(html).not.toContain("production-json");
});
test("文字产物渲染 Markdown 标题、表格、列表与强调", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      content={
        '# 故事圣经\n\n> 画风说明\n\n| 项 | 内容 |\n|---|---|\n| 暂定片名 | **青梧晚晴** |\n\n- 人物\n- 冲突\n\n```json\n{"pass":true}\n```'
      }
    />,
  );
  for (const element of [
    "<h1>",
    "<blockquote>",
    "<table>",
    "<th>",
    "<strong>",
    "<ul>",
    "<pre>",
  ])
    expect(html).toContain(element);
});
test("Markdown 不执行 HTML、危险链接或远程图片请求", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      content={
        "<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![远程追踪图](https://example.com/tracker)\n\n[参考](https://example.com)"
      }
    />,
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
  expect(html).toContain('rel="noopener noreferrer"');
});
test("故事结构检查点显示章节标题与梗概，而不是原始 JSON", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent content={JSON.stringify(outlineFixture)} />,
  );
  expect(html).toContain("故事结构");
  expect(html).toContain("CH001 · 雨中相遇");
  expect(html).toContain("女孩尚未决定是否留下");
  expect(html).not.toContain('"synopsis"');
});
test("完整故事稿仍按章节正文渲染，不被当成结构提纲", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent content={JSON.stringify(storyFixture)} />,
  );
  expect(html).toContain("完整故事稿");
  expect(html).toContain("CH001 · 雨中相遇");
  expect(html).not.toContain("故事结构");
});
test("单章检查点把正文和衔接分开，衔接放在可展开索引里", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent content={JSON.stringify(storyFixture.chapters[0])} />,
  );
  expect(html).toContain("CH001 · 雨中相遇");
  expect(html).toContain("女孩走到山门前");
  expect(html).toContain("衔接与故事段落索引");
  expect(html).toContain("CH001-B001");
  expect(html.indexOf("女孩走到山门前")).toBeLessThan(
    html.indexOf("衔接与故事段落索引"),
  );
});

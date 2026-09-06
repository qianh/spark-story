import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../apps/web/MarkdownContent";
import { timingFixture } from "./fixtures/timing";
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

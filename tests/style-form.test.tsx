import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StyleForm } from "../apps/web/StyleForm";
import { donghuaStylePrompt } from "../packages/visual-style";

test("点开画风先展示生成说明，而不是直接列出全部模板", () => {
  const html = renderToStaticMarkup(
    <StyleForm current="donghua3d" busy={false} onSubmit={() => {}} />,
  );
  expect(html).toContain("三维仙侠国漫");
  expect(html).toContain("当前作品画风");
  expect(html).toContain("生成时使用的画风说明");
  expect(html).toContain("定妆、关键帧和视频都只使用作品里锁定的这一份说明");
  expect(html).toContain("通用画风原文");
  expect(html).toContain("后面只追加资产类型与内容");
  expect(html).toContain(donghuaStylePrompt.slice(0, 40));
  expect(html).toContain("更换其他画风");
  expect(html).not.toContain("INK &amp; SILENCE");
});

test("选中画风模板升级后，新定妆按当前模板生成，不必再点应用", () => {
  const html = renderToStaticMarkup(
    <StyleForm
      current="donghua3d"
      catalog={[
        {
          id: "donghua3d",
          name: "三维仙侠国漫",
          en: "XIANXIA DONGHUA",
          color: "#7b9aa8",
          description: "新模板",
          prompt: "新模板文本：高细节3D CGI仙侠",
        },
      ]}
      applied={{
        id: "donghua3d",
        prompt: "作品锁定：高完成度东方仙侠",
        version: "xianxia-3d-v3",
      }}
      busy={false}
      onSubmit={() => {}}
    />,
  );
  expect(html).toContain("当前作品画风");
  expect(html).toContain("不必再选一次");
  expect(html).toContain("新模板文本：高细节3D CGI仙侠");
  expect(html).not.toContain("按当前模板重新应用");
  expect(html).not.toContain("作品锁定：高完成度东方仙侠");
});

test("从模板库点开未应用画风时，可看到说明并应用到当前作品", () => {
  const html = renderToStaticMarkup(
    <StyleForm
      current="cel"
      focus="donghua3d"
      busy={false}
      onSubmit={() => {}}
    />,
  );
  expect(html).toContain("三维仙侠国漫");
  expect(html).toContain("应用到当前作品");
  expect(html).toContain("UNIVERSAL XIANXIA STYLE");
});

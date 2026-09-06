import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
test("制作规则可编辑、非法区间被拒绝、保存后重置规划但保留概要", async ({
  page,
  request,
}) => {
  const p = await (
    await request.post("/api/projects", {
      data: {
        name: "节奏规则验证",
        source: "少女来信",
        inputType: "idea",
        aspect: "9:16",
        template: "cel",
        budget: 0,
      },
    })
  ).json();
  const before = await (await request.get("/api/projects/" + p.id)).json();
  await page.addInitScript(
    (id) => localStorage.setItem("spark-project", id),
    p.id,
  );
  await page.goto("/");
  await page.getByRole("button", { name: /制作规则 ·/ }).click();
  await expect(page.getByLabel("单集最短（秒）")).toHaveValue("90");
  await expect(page.getByLabel("单集最长（秒）")).toHaveValue("120");
  await page
    .getByText("自然展开 · 单集容量标准（可调整）", { exact: true })
    .click();
  await expect(page.getByLabel("每集最多重大变化")).toHaveValue("1");
  await expect(page.getByLabel("最少独立反应占比")).toHaveValue("0.12");
  await page.getByLabel("估算语速（发音单元/秒）").fill("3.2");
  await page.getByLabel("叙事模板").selectOption("suspense");
  await page.getByRole("button", { name: "保存规则并重新规划" }).click();
  await expect(
    page.getByRole("button", { name: /制作规则 ·.*悬疑解谜/ }),
  ).toBeVisible();
  const after = await (await request.get("/api/projects/" + p.id)).json();
  expect(after.tasks[0].revision).toBe(before.tasks[0].revision);
  expect(after.production.capacity.speechUnitsPerSecond).toBe(3.2);
  expect(after.tasks[1].revision).toBe(before.tasks[1].revision + 1);
  expect(
    (
      await request.put("/api/projects/" + p.id + "/production", {
        data: { minSeconds: 121, maxSeconds: 90 },
      })
    ).status(),
  ).toBe(400);
  await page.screenshot({
    path: "test-results/production-rules.png",
    fullPage: true,
  });
});
test("七阶段：概要确认→分集规划→第一集剧本，每个确认点独立解锁", async ({
  page,
  request,
}) => {
  const saved = await request.post("/api/connections", {
    data: {
      name: "分集链路测试执行器",
      transport: "cli",
      provider: "claude",
      executable: resolve("tests/fixtures/stream-cli.ts"),
      model: "episode-flow",
      reserveCents: 0,
    },
  });
  expect(saved.ok()).toBe(true);
  const connection = await saved.json();
  for (const role of ["主模型", "文本模型"])
    expect(
      (
        await request.post("/api/bindings", {
          data: { role, connectionId: connection.id },
        })
      ).ok(),
    ).toBe(true);
  const p = await (
    await request.post("/api/projects", {
      data: {
        name: "全剧规划验收",
        source: "少女收到明天的信",
        inputType: "idea",
        aspect: "9:16",
        template: "cel",
        budget: 0,
      },
    })
  ).json();
  await page.addInitScript(
    (id) => localStorage.setItem("spark-project", id),
    p.id,
  );
  await page.goto("/");
  await expect(page.locator(".stage-strip button")).toHaveCount(7);
  await page.getByRole("button", { name: "进入当前工作区" }).click();
  for (const [index, title] of [
    "故事概要",
    "全剧分集规划",
    "第一集剧本",
  ].entries()) {
    await expect(page.locator(".page-heading h1")).toContainText(title);
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认此版本" })).toBeVisible({
      timeout: 10000,
    });
    const board = await (await request.get("/api/projects/" + p.id)).json();
    expect(board.tasks[index + 1].status).toBe("blocked");
    if (index === 1) {
      await expect(
        page.getByText(/全剧情节展开清单 · 2 个戏剧单元/),
      ).toBeVisible();
      await expect(page.locator(".markdown-content")).toContainText("内容估算");
      await expect(page.locator(".markdown-content")).toContainText("EP002");
      const bad = await request.post(
        "/api/tasks/" + board.tasks[2].id + "/start",
        { data: { revision: board.tasks[2].revision } },
      );
      expect(bad.status()).toBe(400);
      await page.screenshot({
        path: "test-results/episode-plan.png",
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "确认此版本" }).click();
    const next = ["全剧分集规划", "第一集剧本", "定妆与资产"][index];
    await expect(
      page.getByRole("button", { name: "进入" + next + " →" }),
    ).toBeVisible();
    if (index < 2)
      await page.getByRole("button", { name: "进入" + next + " →" }).click();
  }
  await page.getByRole("button", { name: "返回阶段看板" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("流式草稿实时出现、Markdown 正确渲染、审核可读且完成后才能确认", async ({
  page,
  request,
}) => {
  const project = await (
    await request.post("/api/projects", {
      data: {
        name: "阅读体验验证",
        source: "雨天动漫故事",
        inputType: "idea",
        aspect: "9:16",
        template: "cel",
        budget: 0,
      },
    })
  ).json();
  const board = await (await request.get("/api/projects/" + project.id)).json();
  const task = board.tasks[0];
  task.status = "running";
  const timestamp = new Date().toISOString();
  const progress = {
    taskId: task.id,
    revision: 1,
    phase: "generate",
    actor: "剧情 Agent",
    model: "测试流式连接",
    content: "",
    startedAt: timestamp,
    heartbeatAt: timestamp,
    outputAt: "",
    status: "running",
  };
  board.progress = [progress];
  await page.route("**/api/projects/" + project.id, (route) =>
    route.fulfill({ json: board }),
  );
  await page.addInitScript(
    (id) => localStorage.setItem("spark-project", id),
    project.id,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "进入当前工作区" }).click();
  await expect(
    page.getByText("正在等待第一段正文", { exact: true }),
  ).toBeVisible();
  progress.content =
    "# 青梧晚晴\n\n## 人物设定\n\n| 人物 | 特点 |\n|---|---|\n| 主角 | **善良** |\n\n- 开场冲突\n- 人物动机\n\n> 适度改编";
  progress.outputAt = new Date().toISOString();
  await expect(
    page.getByRole("heading", { name: "青梧晚晴", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".markdown-content table")).toBeVisible();
  await expect(page.locator(".markdown-content strong")).toHaveText("善良");
  await expect(page.getByRole("button", { name: "确认此版本" })).toHaveCount(0);
  await page.getByRole("button", { name: "跟随最新内容" }).click();
  await expect(page.getByRole("button", { name: "停止跟随" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({
    path: "test-results/live-markdown.png",
    fullPage: true,
  });
  task.status = "reviewing";
  progress.phase = "review";
  board.artifacts = [
    {
      id: "test-artifact",
      taskId: task.id,
      revision: 1,
      status: "candidate",
      content: progress.content,
      createdAt: timestamp,
    },
  ];
  await expect(page.getByText("主控正在审核", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "青梧晚晴", exact: true }),
  ).toBeVisible();
  task.status = "awaiting_user";
  board.artifacts[0].status = "reviewed";
  await expect(page.getByRole("button", { name: "确认此版本" })).toBeVisible();
  await page.getByRole("button", { name: "直接编辑" }).click();
  await expect(page.locator(".artifact-editor")).toHaveValue(progress.content);
  await page.getByRole("button", { name: "取消编辑" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("创建项目、持久配置、打开工作区、中断与预算", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "创建第一部作品" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/welcome.png", fullPage: true });
  await page.getByRole("button", { name: "创建第一部作品" }).click();
  const name = "雨天来信 " + Date.now();
  await page.getByLabel("作品名称").fill(name);
  await page
    .getByLabel("故事从这里开始")
    .fill("少女只能在雨天看见未来，她希望改变朋友失约的命运。");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: false })).toBeVisible();
  await page.screenshot({ path: "test-results/board.png", fullPage: true });
  await page.getByRole("button", { name: "模型与连接", exact: true }).click();
  await page.getByRole("button", { name: "添加连接" }).click();
  await page.getByLabel("连接名称").fill("未安装测试工具");
  await page
    .getByLabel("可执行文件绝对路径")
    .fill("/nonexistent/spark-test-cli");
  await page.getByRole("button", { name: "保存连接" }).click();
  await page
    .getByLabel("主模型连接")
    .selectOption({ label: "未安装测试工具 · CLI" });
  await page
    .getByLabel("文本模型连接")
    .selectOption({ label: "未安装测试工具 · CLI" });
  await page.screenshot({
    path: "test-results/connections.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "阶段看板", exact: true }).click();
  await page.getByRole("button", { name: "进入当前工作区" }).click();
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("连接待处理", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("button", { name: "立即中断", exact: true }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回阶段看板" }).click();
  await page.getByRole("button", { name: /API 已预留/ }).click();
  await page.getByLabel("金额（USD）").fill("12.50");
  await page.getByRole("button", { name: "保存预算" }).click();
  await expect(page.getByRole("button", { name: /API 已预留/ })).toContainText(
    "12.50",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("拒绝跨站修改，预算与前置关卡在服务端验证", async ({ request }) => {
  const bad = await request.post("/api/projects", {
    headers: { origin: "https://evil.example" },
    data: {},
  });
  expect(bad.status()).toBe(403);
  const p = await (
    await request.post("/api/projects", {
      data: {
        name: "关卡测试",
        source: "剧情",
        inputType: "idea",
        aspect: "9:16",
        template: "cel",
        budget: 0,
      },
    })
  ).json();
  const b = await (await request.get("/api/projects/" + p.id)).json();
  const response = await request.post(`/api/tasks/${b.tasks[1].id}/start`, {
    data: { revision: 1 },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toContain("前置");
});
test("API 密钥不会出现在配置响应与工作台数据中", async ({ request }) => {
  const secret = "test-secret-" + crypto.randomUUID();
  const saved = await request.post("/api/connections", {
    data: {
      name: "凭据测试",
      transport: "api",
      provider: "compatible",
      model: "test",
      baseUrl: "https://example.com/v1",
      apiKey: secret,
      reserveCents: 10,
    },
  });
  expect(saved.ok()).toBe(true);
  expect(await saved.text()).not.toContain(secret);
  const bootstrap = await request.get("/api/bootstrap");
  expect(await bootstrap.text()).not.toContain(secret);
});
test("真实图片与视频导入、预览、下载和单独生成入口", async ({
  page,
  request,
}) => {
  const project = await (
    await request.post("/api/projects", {
      data: {
        name: "媒体浏览器验证",
        source: "动漫角色在雨中挥手",
        inputType: "idea",
        aspect: "16:9",
        template: "cel",
        budget: 100,
      },
    })
  ).json();
  const board = await (await request.get("/api/projects/" + project.id)).json();
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "#719974" },
  })
    .png()
    .toBuffer();
  const root = await mkdtemp(tmpdir() + "/spark-browser-media-");
  try {
    const path = root + "/preview.mp4";
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=320x180:r=24:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    let imageId = "";
    for (const [name, mimeType, buffer] of [
      ["验证定妆.png", "image/png", image],
      ["验证镜头.mp4", "video/mp4", await readFile(path)],
    ] as const) {
      const r = await request.post(`/api/projects/${project.id}/upload`, {
        multipart: {
          taskId: board.tasks[0].id,
          file: { name, mimeType, buffer },
        },
      });
      expect(r.ok()).toBe(true);
      const f = await r.json();
      if (mimeType === "image/png") imageId = f.id;
    }
    await page.addInitScript(
      (id) => localStorage.setItem("spark-project", id),
      project.id,
    );
    await page.goto("/");
    await page
      .getByRole("heading", { name: "媒体浏览器验证", exact: false })
      .waitFor();
    await page.getByRole("button", { name: "进入当前工作区" }).click();
    const img = page.getByAltText("验证定妆.png");
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(320);
    await expect
      .poll(() =>
        page
          .locator("video")
          .first()
          .evaluate((v: HTMLVideoElement) => v.readyState),
      )
      .toBeGreaterThan(0);
    await page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.play());
    await expect
      .poll(() =>
        page
          .locator("video")
          .first()
          .evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0);
    const downloaded = await request.get(
      "/api/media/files/" + imageId + "?download=1",
    );
    expect(downloaded.headers()["content-type"]).toContain("image/png");
    expect((await downloaded.body()).length).toBe(image.length);
    await page.getByRole("button", { name: "单独生成", exact: false }).click();
    await expect(page.getByLabel("生成类型")).toBeVisible();
    await page.getByLabel("生成类型").selectOption("video");
    await expect(
      page.getByRole("button", { name: "提交真实生成" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/media-workspace.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

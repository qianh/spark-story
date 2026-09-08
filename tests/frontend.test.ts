import { expect, test } from "bun:test";
import { proxyVite, serveDist } from "../apps/server/frontend";

test("开发代理把页面转到 Vite，不读旧的 dist", async () => {
  const vite = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("from-vite", { headers: { "content-type": "text/plain" } }),
  });
  try {
    const res = await proxyVite(
      new Request("http://127.0.0.1:4310/apps/web/main.tsx"),
      `http://127.0.0.1:${vite.port}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-vite");
  } finally {
    vite.stop(true);
  }
});

test("未启动 Vite 时提供已构建的前端", async () => {
  const res = await serveDist(new Request("http://127.0.0.1:4310/"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Spark Story");
});

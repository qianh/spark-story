import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { proxyVite, serveDist } from "../apps/server/frontend";
import { ignoreTransientSocketErrors } from "../apps/web/ignore-socket-reset";
import { withLocalNoProxy } from "../scripts/dev-env";

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

test("HTTP 连接被重置时不把 ECONNRESET 当成未处理错误", () => {
  const server = new EventEmitter();
  ignoreTransientSocketErrors(server);
  const socket = new EventEmitter();
  server.emit("connection", socket);
  const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  expect(() => socket.emit("error", err)).not.toThrow();
});

test("开发子进程为本机连接设置 NO_PROXY，避免系统代理掐断 Vite", () => {
  const env = withLocalNoProxy({
    HTTP_PROXY: "http://127.0.0.1:1082",
    NO_PROXY: "example.com",
  });
  expect(env.HTTP_PROXY).toBe("http://127.0.0.1:1082");
  expect(env.NO_PROXY).toContain("127.0.0.1");
  expect(env.NO_PROXY).toContain("localhost");
  expect(env.NO_PROXY).toContain("example.com");
  expect(env.no_proxy).toBe(env.NO_PROXY);
});

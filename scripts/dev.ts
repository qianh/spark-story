import { withLocalNoProxy } from "./dev-env";

const viteOrigin = `http://127.0.0.1:${process.env.SPARK_VITE_PORT || 5173}`;
const env = withLocalNoProxy({ ...process.env, SPARK_VITE_ORIGIN: viteOrigin });
const server = Bun.spawn(["bun", "--watch", "apps/server/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env,
});
function spawnWeb() {
  return Bun.spawn(["bun", "run", "dev:web"], {
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
}
let web = spawnWeb();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill();
  web.kill();
}
async function superviseWeb() {
  while (!stopping) {
    const code = await web.exited;
    if (stopping) return;
    console.error(`Vite 退出（${code ?? "unknown"}），正在重启前端热更新…`);
    await Bun.sleep(400);
    if (stopping) return;
    web = spawnWeb();
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([server.exited.then(() => stop()), superviseWeb()]);
await Promise.all([server.exited, web.exited]);
export {};

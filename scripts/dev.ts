const viteOrigin = `http://127.0.0.1:${process.env.SPARK_VITE_PORT || 5173}`;
const children = [
  Bun.spawn(["bun", "--watch", "apps/server/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, SPARK_VITE_ORIGIN: viteOrigin },
  }),
  Bun.spawn(["bun", "run", "dev:web"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  children.forEach((p) => p.kill());
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(children.map((p) => p.exited));
stop();
await Promise.all(children.map((p) => p.exited));
export {};

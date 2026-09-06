const commands = [
  ["bun", "--watch", "apps/server/index.ts"],
  ["bun", "run", "dev:web"],
];
const children = commands.map((cmd) =>
  Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" }),
);
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

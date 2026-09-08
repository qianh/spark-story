import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const dist = resolve("dist");
const vitePort = Number(process.env.SPARK_VITE_PORT || 5173);
const viteGuess = `http://127.0.0.1:${vitePort}`;
let viteLiveUntil = 0;

export function configuredViteOrigin() {
  return process.env.SPARK_VITE_ORIGIN || "";
}

export async function liveViteOrigin() {
  const configured = configuredViteOrigin();
  if (configured) return configured;
  if (Date.now() < viteLiveUntil) return viteGuess;
  try {
    const r = await fetch(new URL("/@vite/client", viteGuess), {
      signal: AbortSignal.timeout(200),
    });
    if (r.ok) {
      viteLiveUntil = Date.now() + 5000;
      return viteGuess;
    }
  } catch {}
  return "";
}

export async function proxyVite(req: Request, origin: string) {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, origin);
  const headers = new Headers(req.headers);
  headers.set("host", target.host);
  headers.delete("connection");
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    (init as { duplex?: string }).duplex = "half";
  }
  let last = "连接失败";
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(target, init);
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await Bun.sleep(100);
    }
  }
  return new Response("前端开发服务未就绪：" + last, { status: 503 });
}

export async function serveDist(req: Request) {
  const path = new URL(req.url).pathname;
  const file = resolve(dist, "." + decodeURIComponent(path));
  if (
    file.startsWith(dist + sep) &&
    existsSync(file) &&
    (await Bun.file(file).stat()).isFile()
  )
    return new Response(Bun.file(file));
  if (existsSync(join(dist, "index.html")))
    return new Response(Bun.file(join(dist, "index.html")));
  return new Response(
    "前端尚未构建。开发时使用 bun run dev，或先执行 bun run build。",
    { status: 503 },
  );
}

export async function serveFrontend(req: Request, viteOrigin?: string) {
  const vite = viteOrigin ?? (await liveViteOrigin());
  if (vite) return proxyVite(req, vite);
  return serveDist(req);
}

type HmrSocket = {
  data: {
    url: string;
    vite: string;
    backend?: WebSocket;
    queue: (string | Buffer)[];
  };
  send(data: string | Buffer | ArrayBuffer): void;
  close(): void;
};

export function connectViteHmr(ws: HmrSocket) {
  const target = ws.data.vite.replace(/^http/, "ws") + ws.data.url;
  const backend = new WebSocket(target);
  ws.data.backend = backend;
  ws.data.queue = ws.data.queue || [];
  backend.addEventListener("open", () => {
    for (const m of ws.data.queue) backend.send(m);
    ws.data.queue = [];
  });
  backend.addEventListener("message", (ev) => {
    try {
      ws.send(ev.data as string | Buffer);
    } catch {}
  });
  backend.addEventListener("close", () => {
    try {
      ws.close();
    } catch {}
  });
  backend.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

export function forwardViteHmr(ws: HmrSocket, message: string | Buffer) {
  const backend = ws.data.backend;
  if (!backend || backend.readyState !== WebSocket.OPEN) {
    ws.data.queue.push(message);
    return;
  }
  backend.send(message);
}

export function closeViteHmr(ws: HmrSocket) {
  try {
    ws.data.backend?.close();
  } catch {}
}

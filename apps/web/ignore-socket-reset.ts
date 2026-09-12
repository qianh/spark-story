type SocketLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  destroy?: () => void;
};

type HttpServerLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
};

const ignored = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

function ignoreTransient(err?: { code?: string }) {
  if (err?.code && ignored.has(err.code)) return;
  if (err) console.error(err);
}

export function ignoreTransientSocketErrors(server?: HttpServerLike | null) {
  if (!server) return;
  server.on("connection", (socket: SocketLike) => {
    socket.on("error", ignoreTransient);
  });
  server.on("clientError", (err: { code?: string }, socket: SocketLike) => {
    ignoreTransient(err);
    try {
      socket.destroy?.();
    } catch {}
  });
}

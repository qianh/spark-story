import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { ignoreTransientSocketErrors } from "./apps/web/ignore-socket-reset";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "ignore-transient-socket-errors",
      configureServer(server) {
        ignoreTransientSocketErrors(server.httpServer);
        server.ws?.on?.("error", () => {});
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4310" },
  },
  build: { outDir: "dist" },
});


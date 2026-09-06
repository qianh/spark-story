import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4311",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `PORT=4311 SPARK_DATA_DIR=.spark-story/e2e-${Date.now()} bun apps/server/index.ts`,
    url: "http://127.0.0.1:4311/api/bootstrap",
    reuseExistingServer: false,
  },
});

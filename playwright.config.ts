import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: ".browser-results",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:18180",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 960, height: 800 } } }],
  webServer: {
    command: "npm run build && node dist/server/index.js",
    url: "http://127.0.0.1:18180/api/health",
    env: { PORT: "18180", HOST: "127.0.0.1", DATA_FILE: ":memory:" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

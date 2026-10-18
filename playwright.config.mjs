import { defineConfig, devices } from "@playwright/test";

// The smoke tests drive the Docker Foundry server from compose.yaml.
// Start it first with `npm run foundry:up`.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.spec.mjs",
  // One Foundry world is shared state, so run the tests one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.FOUNDRY_URL ?? "http://localhost:30100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  // Foundry needs a window of at least 1024x768. The Desktop Chrome default is 1280x720.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }]
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  tsconfig: "../tsconfig.playwright.json",
  testDir: "./test",
  // Windows CI runs every fixture e2e concurrently; absorb runner flakiness.
  retries: process.env.CI ? 2 : 0,
  // A systemic failure (runner capacity, broken build) otherwise burns
  // retries x timeout on every remaining spec — fail the suite fast.
  maxFailures: process.env.CI ? 5 : 0,
  // Cold dev boots (vite + workerd + module-runner connect) and the
  // edit-poll-restore HMR specs need headroom over the usual 60s.
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        colorScheme: "light",
        deviceScaleFactor: 1,
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});

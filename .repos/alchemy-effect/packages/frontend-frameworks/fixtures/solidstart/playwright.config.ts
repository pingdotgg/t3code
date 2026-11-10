import { defineConfig } from "@playwright/test";

export default defineConfig({
  tsconfig: "../tsconfig.playwright.json",
  testDir: "./test",
  timeout: 60_000,
  // The dev-mode smoke test is flaky on CI (it also fails intermittently on
  // main, e.g. runs 30733973174/30733916976): this fixture pins vite 7 (for
  // @solidjs/start) while the workspace catalog resolves the cloudflare
  // plugins against vite 8, so the vite-8 dependency scanner crashes on the
  // vite-7-resolved environment config ("Failed to run dependency scan ...
  // reading 'input'"). Dependencies are then discovered lazily on first
  // request, and the resulting "optimized dependencies changed" full reloads
  // race the first page load. The server reaches steady state after those
  // reloads, so a retry against the same worker-scoped server is reliable.
  retries: process.env.CI ? 2 : 0,
  // A systemic failure (runner capacity, broken build) otherwise burns
  // retries x timeout on every remaining spec — fail the suite fast.
  maxFailures: process.env.CI ? 5 : 0,
  expect: {
    timeout: 10_000,
  },
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
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

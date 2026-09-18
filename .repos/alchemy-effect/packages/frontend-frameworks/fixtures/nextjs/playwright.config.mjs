import { defineConfig } from "@playwright/test";

export default defineConfig({
  tsconfig: "../tsconfig.playwright.json",
  testDir: "./test",
  // Windows CI runs every fixture e2e concurrently; absorb runner flakiness.
  retries: process.env.CI ? 2 : 0,
  // Retries x timeout inflation makes a truly-broken suite take ~25 minutes
  // to fail on CI; bail after a handful of failures instead.
  maxFailures: process.env.CI ? 5 : 0,
  // The dev worker fixture runs a full OpenNext build on start (preview
  // parity — no build.json reuse), so keep generous timeouts.
  timeout: 120_000,
  // Serialize workers: the dev fixture's OpenNext build rewrites
  // `.open-next/assets` on disk, which a concurrently-running live
  // (miniflare) worker serves from — parallel workers race on it.
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  build: {
    // The hmr spec runs `next dev` inside the playwright worker process;
    // keep playwright's babel require-hook away from Turbopack's dev chunks
    // (their sectioned source maps break it with BABEL_GENERATE_ERROR).
    external: ["**/.next/**"],
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

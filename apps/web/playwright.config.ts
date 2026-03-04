import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "*.browser.e2e.ts",
  reporter: "list",
  fullyParallel: true,
  outputDir: "./.playwright/test-results",
  use: {
    headless: true,
  },
});

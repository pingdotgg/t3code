import * as NodeOS from "node:os";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "html-visualization.spec.ts",
  fullyParallel: false,
  workers: 1,
  outputDir: `${NodeOS.tmpdir()}/t3-html-visualization-${process.pid}`,
  reporter: "list",
  use: { browserName: "chromium", viewport: { width: 900, height: 700 } },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/perf/**/*.perf.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});

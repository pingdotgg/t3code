import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Windows CI has been failing the suite with "Worker exited unexpectedly"
    // after every test file passed (vitest fork teardown). Cap workers like
    // cloudflare-runtime so a dying fork cannot fail a green run.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    pool: "forks",
  },
});

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const apiGatewayInclude = ["test/AWS/ApiGateway/**/*.test.ts"];

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    root: "packages/alchemy",
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/lib/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    env: { NODE_ENV: "test" },
    globals: true,
    setupFiles: ["test/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        ".distilled/**",
        "coverage/**",
        "dist/**",
        "lib/**",
        "**/node_modules/**",
        "**/*.test.ts",
        "**/*.config.*",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "alchemy",
          // Bun's worker_threads segfaults under vitest's "threads" pool
          // (tinypool) at worker spawn. "forks" uses child_process, which
          // Bun handles reliably. Tests here are network/IO-bound, so the
          // per-fork startup cost is negligible.
          pool: "forks",
          maxWorkers: 32,
          sequence: { concurrent: true },
          include: ["test/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/lib/**",
            "**/.{idea,git,cache,output,temp}/**",
            ...apiGatewayInclude,
          ],
        },
      },
      {
        // API Gateway has account-wide throttles that are unworkable under
        // any concurrency: DeleteRestApi alone allows 1 request per 30s.
        // Force a single fork, no file parallelism, and sequential tests
        // within each file so the whole suite runs as a single line of
        // mutations. Bump timeouts so that retry budgets covering the
        // throttle window don't blow the default 120s ceiling.
        extends: true,
        test: {
          name: "apigateway",
          pool: "forks",
          singleFork: true,
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 600_000,
          hookTimeout: 600_000,
          include: apiGatewayInclude,
        },
      },
    ],
  },
});

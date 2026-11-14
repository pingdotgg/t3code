import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

const sourceRoot = (...parts: Array<string>) => path.resolve(import.meta.dirname, "src", ...parts);

const coreRoot = sourceRoot("core");
const rolldownRoot = sourceRoot("rolldown");
const viteRoot = sourceRoot("vite");
const workersSharedRoot = sourceRoot("internal/workers-shared");
const workflowsSharedRoot = sourceRoot("internal/workflows-shared");

/**
 * Suites that run Linux container images on a Docker daemon. CI's macOS and
 * Windows runners can't host one (Apple Silicon VMs have no nested
 * virtualization; Windows runs only Windows containers), so
 * cloudflare-tools.yml sets `ALCHEMY_TEST_EXCLUDE_LINUX_CONTAINERS` there and
 * these run on its Linux runner. Everywhere else they run, and a missing
 * daemon fails them.
 */
const linuxContainerSuites = [
  "test/DockerDaemon.test.ts",
  "test/bindings/Container.test.ts",
  "test/bindings/NativeContainer.test.ts",
];

export default defineConfig({
  test: {
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    projects: [
      {
        root: coreRoot,
        test: {
          name: "core",
          include: ["test/**/*.test.ts"],
          exclude: process.env.ALCHEMY_TEST_EXCLUDE_LINUX_CONTAINERS
            ? [...configDefaults.exclude, ...linuxContainerSuites]
            : configDefaults.exclude,
          setupFiles: ["./test/setup.ts"],
          pool: "forks",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          retry: process.env.CI ? 2 : 0,
        },
      },
      {
        root: rolldownRoot,
        test: {
          name: "rolldown",
          env: loadEnv("test", rolldownRoot, "TEST"),
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: "forks",
          fileParallelism: true,
        },
      },
      {
        root: viteRoot,
        resolve: {
          alias: {
            "#": viteRoot,
          },
        },
        test: {
          name: "vite",
          env: loadEnv("test", viteRoot, "TEST"),
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: "forks",
          fileParallelism: true,
        },
      },
      {
        root: workersSharedRoot,
        test: {
          name: "workers-shared-node",
          include: ["node/**/*.test.ts", "shared/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        root: workersSharedRoot,
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: sourceRoot("internal/workers-shared/workers/asset-worker/wrangler.jsonc"),
            },
          }),
        ],
        test: {
          name: "workers-shared-assets",
          include: ["workers/asset-worker/tests/**/*.test.ts"],
          globals: true,
          testTimeout: 50_000,
        },
      },
      {
        root: workersSharedRoot,
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: sourceRoot(
                "internal/workers-shared/workers/router-worker/wrangler.jsonc",
              ),
            },
          }),
        ],
        test: {
          name: "workers-shared-router",
          include: ["workers/router-worker/tests/**/*.test.ts"],
          testTimeout: 50_000,
        },
      },
      {
        root: workflowsSharedRoot,
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityFlags: ["service_binding_extra_handlers"],
            },
            wrangler: {
              configPath: sourceRoot("internal/workflows-shared/wrangler.jsonc"),
            },
          }),
        ],
        test: {
          name: "workflows-shared",
          include: ["test/**/*.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          testTimeout: 50_000,
        },
      },
    ],
  },
});

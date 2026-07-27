import "vite-plus/test/config";
import * as NodeOS from "node:os";

import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

/**
 * Worker cap for the server test pool. See the `test` block below for why this
 * is bounded rather than "one per core".
 *
 * Measured on an 18-core host with three other agent worktrees compiling and
 * testing at the same time — which is the normal state of this machine, not a
 * stress test:
 *
 *   1 worker (the old `fileParallelism: false`)  138s, green
 *   4 workers                                     38-58s, green over three runs
 *   6 workers                                     45-50s, `server.test.ts` failed
 *   10+ workers                                   126s, a 120s timeout in AcpJsonRpcConnection
 *
 * Past four workers the win is gone and the losses start: the files starve each
 * other badly enough that real HTTP round-trips in `server.test.ts` come back
 * 401/400. Four is the knee of that curve, so that is the cap.
 *
 * The floor is one, not two. A single-core CI runner has to be able to fall
 * back to serial execution: forcing a second worker onto a host with one usable
 * CPU reproduces exactly the starvation this cap exists to avoid.
 *
 * `T3_SERVER_TEST_WORKERS` overrides both ends for hosts this heuristic reads
 * wrong — a container with a low CPU quota but a high `availableParallelism()`,
 * or a big idle machine where a wider pool is worth measuring. A value that is
 * not a positive integer is ignored rather than silently treated as one worker.
 */
function resolveServerTestWorkers(): number {
  const override = Number(process.env.T3_SERVER_TEST_WORKERS);
  if (Number.isInteger(override) && override > 0) {
    return override;
  }
  return Math.max(1, Math.min(4, NodeOS.availableParallelism() - 1));
}

const serverTestWorkers = resolveServerTestWorkers();

const bundledPackagePrefixes = [
  "@pierre/diffs",
  "@t3tools/",
  "effect-acp",
  "effect-codex-app-server",
];

export function shouldBundleCliDependency(id: string): boolean {
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

const repoEnv = loadRepoEnv();

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // This suite is the monorepo's whole test bill: 179 files and ~95s of test
      // work, against ~2s for every other package combined. Running it one file
      // at a time cost 139s wall; spreading it across a bounded worker pool
      // costs ~40s for the same 1643 tests.
      //
      // Bounded, not unbounded: the suite spawns real `git` and mock-agent
      // processes, and several agent worktrees run their suites on this machine
      // at once. At one worker per core the files starve each other badly enough
      // that timing-sensitive tests time out. The cap keeps the win without the
      // contention, and leaves cores for whoever else is building.
      fileParallelism: true,
      maxWorkers: serverTestWorkers,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);

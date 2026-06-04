import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

const bundledPackagePrefixes = [
  "@pierre/diffs",
  "@t3tools/",
  "effect-acp",
  "effect-codex-app-server",
];

export function shouldBundleCliDependency(id: string): boolean {
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
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
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);

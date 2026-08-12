import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

const bundledPackagePrefixes = [
  "@pierre/diffs",
  "@t3tools/",
  "effect-acp",
  "effect-codex-app-server",
];

// WSL loads the packaged CLI through a Windows filesystem mount resolved by
// wslpath (commonly /mnt/c). Resolving a large dependency graph there is
// substantially slower than reading a few bundled chunks. Bundle direct runtime
// dependencies by default so adding a normal JS dependency cannot silently
// regress startup. Exceptions own native binaries, target another runtime, or
// resolve package assets at runtime and must stay in node_modules.
const externalRuntimePackageNames = new Set([
  // Resolves its CLI and other files from the installed package.
  "@anthropic-ai/claude-agent-sdk",

  // Loaded only when the server runs under Bun.
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",

  // Load platform-specific native binaries from node_modules.
  "@ff-labs/fff-node",
  "node-pty",
]);
const runtimePackageNames = new Set(Object.keys(packageJson.dependencies));

function packageNameFromId(id: string): string {
  if (id.startsWith("@")) {
    const [scope, name] = id.split("/");
    return scope && name ? `${scope}/${name}` : id;
  }

  return id.split("/")[0] ?? id;
}

export function shouldBundleCliDependency(id: string): boolean {
  const packageName = packageNameFromId(id);
  if (externalRuntimePackageNames.has(packageName)) {
    return false;
  }

  return (
    runtimePackageNames.has(packageName) ||
    bundledPackagePrefixes.some((prefix) => id.startsWith(prefix))
  );
}

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";

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
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
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

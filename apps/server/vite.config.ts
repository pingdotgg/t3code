import "vite-plus/test/config";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- tsdown needs the asset path when it reads this config.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import rootPackageJson from "../../package.json" with { type: "json" };
import packageJson from "./package.json" with { type: "json" };
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";
import { resolveCliExecutableTarget } from "./scripts/cliExecutableTarget.ts";

// NSIS install time tracks file count, not bytes.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
  ? "nightly"
  : "latest";
// Official release workflows set the telemetry channel; local builds and forks use "dev".
const TELEMETRY_CHANNELS = ["stable", "nightly", "preview", "dev"];
const telemetryChannel = process.env.T3CODE_TELEMETRY_CHANNEL?.trim() || "dev";
if (!TELEMETRY_CHANNELS.includes(telemetryChannel)) {
  throw new Error(
    `T3CODE_TELEMETRY_CHANNEL must be one of ${TELEMETRY_CHANNELS.join(", ")}, got "${telemetryChannel}".`,
  );
}

// tsdown SEA needs one chunk (sourcemaps count) and Node >=25.7, so package separately.
const packCodeIntelligenceWorker = process.env.T3CODE_PACK_CODE_INTELLIGENCE_WORKER === "1";
// "bundle" emits the embedded CLI. "1" builds dist-exe/t3 from the bootstrap.
// TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
// "bootstrap" stops at bin.mjs for scripts/cli.ts to inject (linux-arm64).
const packMode = process.env.T3CODE_PACK_EXE;
const packBootstrap = packMode === "1" || packMode === "bootstrap";
const packExecutable = packBootstrap || packMode === "bundle";
const cliAssetDir = process.env.T3CODE_CLI_ASSET_DIR ?? "";
if (packExecutable && !cliAssetDir) throw new Error("Build the executable with build:exe.");
const packExecutableTarget = resolveCliExecutableTarget({
  enabled: packExecutable,
  target: process.env.T3CODE_PACK_EXE_TARGET,
  nodeVersion: rootPackageJson.engines.node,
  hostNodeVersion: process.versions.node,
  // The running Node is the one tsdown embeds for a native build.
  hostPlatform: Effect.runSync(HostProcess.Platform),
  hostArch: Effect.runSync(HostProcess.Architecture),
});

// The root config's `projects` route repo-root runs to package configs,
// including this one. Inheriting them would make this config a container.
const { projects: _rootTestProjects, ...baseTestConfig } = baseConfig.test ?? {};
// Workspace cache configuration is invalid on a package config.
const { run: _rootRunConfig, ...basePackageConfig } = baseConfig;

export default mergeConfig(
  { ...basePackageConfig, test: baseTestConfig },
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
      entry: packCodeIntelligenceWorker
        ? ["src/project/knowledge/codeIntelligenceWorkerThread.ts"]
        : packBootstrap
          ? ["src/bin.ts"]
          : packExecutable
            ? ["src/binMain.ts"]
            : [
                "src/bin.ts",
                "src/claude-history-worker.ts",
                "src/project/knowledge/codeIntelligenceWorkerThread.ts",
              ],
      outDir: packCodeIntelligenceWorker
        ? "dist-exe-code-intelligence-worker"
        : packBootstrap
          ? "dist-exe"
          : packExecutable
            ? cliAssetDir
            : "dist",
      sourcemap: !packExecutable && !packCodeIntelligenceWorker,
      clean: true,
      // SEA can only resolve built-ins; keep dynamic imports inside each emitted module.
      ...(packExecutable ? { outputOptions: { codeSplitting: false } } : {}),
      ...(!packCodeIntelligenceWorker && packMode === "1"
        ? {
            exe: {
              ...packExecutableTarget,
              outDir: "dist-exe",
              // Node SEA useCodeCache breaks import(), which the server needs.
              seaConfig: {
                useCodeCache: false,
                // The bootstrap loads the embedded CLI with require(esm).
                execArgv: ["--require-module", "--liftoff-only"],
                assets: { "binMain.mjs": NodePath.join(cliAssetDir, "binMain.mjs") },
              },
            },
          }
        : {}),
      deps: {
        // alwaysBundle=false has no opinion; neverBundle must retain transitive native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) =>
          (packBootstrap && id === "./binMain.ts") || isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_TELEMETRY_CHANNEL__: JSON.stringify(telemetryChannel),
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
      // Parallel sqlite/git/worktree/orchestration tests introduce load-sensitive flakes.
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      setupFiles: [
        "./src/testUtils/gitConfig.setup.ts",
        "./src/testUtils/managedServiceEnv.setup.ts",
      ],
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);

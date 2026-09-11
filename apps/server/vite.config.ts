import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

// The bundle used to inline only workspace packages, leaving every third-party
// runtime dep external. External deps must exist on the real filesystem (the WSL
// backend runs plain `wsl.exe -- node`, which cannot read inside an asar), so the
// desktop build unpacked `**\/node_modules\/**` wholesale: 13,875 loose files to
// support 20 native binaries. NSIS install time tracks file count, not bytes.
//
// Inverted here — bundle everything except the packages that genuinely cannot be
// inlined. See scripts/lib/cli-external-packages.ts for what earns an exemption.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
  ? "nightly"
  : "latest";

// `build:exe` wraps the same bundle in a Node single-executable. tsdown's exe
// step refuses multi-chunk output and counts the sourcemap as a chunk, and the
// executable needs a host Node that supports `--build-sea` (25.7+), so this is
// a separate mode rather than a second entry in the default build.
const packExecutable = process.env.T3CODE_PACK_EXE === "1";
// `<platform>-<arch>` in nodejs.org naming (darwin-x64, linux-arm64, win-x64).
// When set, tsdown injects the bundle into a downloaded Node of that target
// instead of the host Node, which is how the arm64 macOS runner produces the
// x64 archive. Cross-building is safe because the code cache is off.
const packExecutableTarget = process.env.T3CODE_PACK_EXE_TARGET?.trim();
const packExecutableTargets = packExecutableTarget
  ? [
      {
        platform: packExecutableTarget.split("-")[0] as "darwin" | "linux" | "win",
        arch: packExecutableTarget.split("-")[1] as "arm64" | "x64",
        nodeVersion: process.versions.node,
      },
    ]
  : undefined;

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
      // The executable embeds one entry; the history worker becomes a hidden
      // subcommand there instead of a sibling script.
      entry: packExecutable ? ["src/bin.ts"] : ["src/bin.ts", "src/claudeHistoryWorker.ts"],
      outDir: packExecutable ? "dist-exe" : "dist",
      sourcemap: !packExecutable,
      clean: true,
      ...(packExecutable
        ? {
            exe: {
              fileName: "t3",
              outDir: "dist-exe",
              ...(packExecutableTargets ? { targets: packExecutableTargets } : {}),
              // Node's SEA docs: `import()` does not work when useCodeCache is
              // true, and the server reaches several modules that way. The
              // cache is also platform-bound, so leaving it off keeps the
              // build correct on any host.
              seaConfig: { useCodeCache: false },
            },
          }
        : {}),
      deps: {
        // Both halves are required. `alwaysBundle` forces the JS dependencies in
        // (declared deps are external by default, which is what this change is
        // undoing). `neverBundle` forces the native packages out: returning
        // false from `alwaysBundle` only means "no opinion", so a transitive
        // dependency would still be bundled — which silently inlined
        // msgpackr-extract and its loader, losing native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
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
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);

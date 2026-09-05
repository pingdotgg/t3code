import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { isExternalCliDependency } from "../../scripts/lib/cli-external-packages.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoEnv = loadRepoEnv();
const shouldLaunchElectronAfterPack = process.env.T3CODE_DESKTOP_DEV === "1";
const publicConfigDefine = {
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
  ),
};

export default defineConfig({
  run: {
    tasks: {
      build: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["t3#build"],
        cache: false,
      },
      "dev:bundle": {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        dependsOn: ["t3#build"],
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: { main: "src/bootstrap.ts", runtime: "src/main.ts" },
      clean: true,
      deps: {
        // Avoid loading the Effect module graph from disk before Electron can start.
        alwaysBundle: (id) =>
          id.startsWith("@t3tools/") ||
          id === "effect" ||
          id.startsWith("effect/") ||
          id === "@effect/platform-node" ||
          id.startsWith("@effect/platform-node/") ||
          id === "@effect/platform-node-shared" ||
          id.startsWith("@effect/platform-node-shared/") ||
          id === "electron-updater" ||
          id.startsWith("electron-updater/"),
        neverBundle: isExternalCliDependency,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/preload.ts"],
      deps: {
        // Sandboxed Electron preloads cannot reliably resolve package imports
        // from inside the packaged ASAR. Bundle Clerk's preload bridge into the
        // preload artifact instead of leaving a runtime require() behind.
        alwaysBundle: (id) => id === "@clerk/electron" || id.startsWith("@clerk/electron/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
    },
  ],
  test: {
    // The Windows lane runs workspace suites concurrently; filesystem-heavy
    // desktop integration tests can exceed Vitest's 5 second default there.
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
});

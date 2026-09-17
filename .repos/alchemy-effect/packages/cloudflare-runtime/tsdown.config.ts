import { defineConfig, type UserConfig } from "tsdown";
import {
  InternalWorkerExportPlugin,
  RuntimeSubpathExportPlugin,
} from "./src/internal/build-tools/index.ts";
import cloudflare from "./src/rolldown/plugin.ts";

/**
 * Internal workers are built per compatibility-flag set: the `cloudflare`
 * plugin adjusts its bundling (Node.js polyfills, warnings) based on the
 * flags, which apply to a whole build.
 */
const workerConfig = (
  entry: Array<string> | Record<string, string>,
  options: { compatibilityFlags?: Array<string>; clean?: boolean } = {},
): UserConfig => ({
  cwd: ".",
  entry,
  outDir: "dist/core/workers",
  clean: options.clean,
  tsconfig: "tsconfig.json",
  format: "esm",
  minify: {
    mangle: false,
  },
  target: "esnext",
  dts: false,
  // The cloudflare/build-utils plugins are typed against the workspace's
  // rolldown while tsdown's `UserConfig` is typed against its own nested
  // copy; the structural compare between the two plugin types blows tsc's
  // depth limit, so bridge through `unknown`.
  plugins: [
    cloudflare({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: options.compatibilityFlags,
    }),
    InternalWorkerExportPlugin(),
  ] as unknown as UserConfig["plugins"],
  deps: {
    alwaysBundle: [/.+/],
  },
  outputOptions: {
    entryFileNames: "[name].mjs",
  },
});

export default defineConfig([
  {
    cwd: ".",
    entry: ["src/rolldown/**/*.ts", "!src/rolldown/test/**/*.ts"],
    exports: false,
    outDir: "dist/rolldown",
    tsconfig: "tsconfig.json",
    unbundle: true,
    dts: { incremental: false },
    shims: false,
    sourcemap: true,
    target: "esnext",
    format: "esm",
    outputOptions: {
      entryFileNames: "[name].js",
    },
  },
  // `internal/shared.worker.ts` is a module shared between the workers, not a
  // worker itself, so it isn't an entry: it's bundled into its importers (as
  // a shared chunk when there are several).
  workerConfig([
    "src/core/**/*.worker.ts",
    "!src/core/internal/shared.worker.ts",
    "!src/core/**/R2Bucket.worker.ts",
  ]),
  // The R2 worker uses `node:crypto` and runs with `nodejs_compat`. Don't
  // clean the shared `dist/workers` directory, which the previous config
  // already populated. The entry is named explicitly to keep the output at
  // the path `worker:` imports resolve to.
  workerConfig(
    {
      "bindings/r2-bucket/R2Bucket.worker":
        "src/core/bindings/r2-bucket/R2Bucket.worker.ts",
    },
    { compatibilityFlags: ["nodejs_compat"], clean: false },
  ),
  {
    cwd: ".",
    entry: [
      "src/core/**/*.ts",
      "!src/core/**/*.worker.ts",
      "!src/core/globals.d.ts",
      "!src/core/scripts/**/*.ts",
      "!src/core/test/**/*.ts",
    ],
    // The consolidated package owns a hand-authored, prefixed export map.
    // Component builds must never rewrite the root package.json.
    exports: false,
    outDir: "dist/core/node",
    tsconfig: "tsconfig.json",
    unbundle: true,
    dts: { incremental: false },
    shims: false,
    target: "esnext",
    format: "esm",
    inputOptions: {
      external: [/^#cloudflare-runtime-/],
      makeAbsoluteExternalsRelative: true,
    },
    outputOptions: {
      entryFileNames: (chunkInfo) => {
        const name = chunkInfo.name.replace(
          /(^node_modules\/.+\/node_modules\/)|(^packages\/vendor\/)/,
          "vendor/",
        );
        return `${name}.${name.endsWith(".d") ? "mts" : "mjs"}`;
      },
    },
  },
  {
    cwd: ".",
    entry: ["src/vite/**/*.worker.ts"],
    outDir: "dist/vite/workers",
    tsconfig: "tsconfig.json",
    format: "esm",
    minify: {
      mangle: false,
    },
    plugins: [
      cloudflare({ compatibilityDate: "2026-03-10" }),
      InternalWorkerExportPlugin(),
    ],
    deps: {
      alwaysBundle: [/.+/],
    },
    dts: false,
    outputOptions: {
      entryFileNames: "[name].mjs",
    },
  },
  {
    cwd: ".",
    entry: ["src/vite/plugin.ts"],
    exports: false,
    outDir: "dist/vite/node",
    tsconfig: "tsconfig.json",
    dts: { incremental: false },
    shims: false,
    target: "esnext",
    format: "esm",
    plugins: [RuntimeSubpathExportPlugin()],
    deps: {
      // These are subpaths of this consolidated package. Keep them as public
      // imports so the Vite declaration bundle shares the core runtime types.
      neverBundle: [/^@alchemy\.run\/cloudflare-runtime(?:\/|$)/],
    },
    inputOptions: {
      external: [
        /^#cloudflare-runtime-/,
        /^@alchemy\.run\/cloudflare-runtime(?:\/|$)/,
      ],
      makeAbsoluteExternalsRelative: true,
    },
    outputOptions: {
      exports: "named",
    },
  },
]);

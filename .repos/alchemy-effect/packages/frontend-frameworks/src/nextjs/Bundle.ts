import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Esbuild from "esbuild";
import * as NodePath from "node:path";

export class BundleError extends Data.TaggedError<"BundleError">(
  "BundleError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The entry module name the final bundle pass emits. */
export const WORKER_ENTRY_NAME = "worker.js";

/**
 * The per-output-file banner wrangler also injects: CJS-converted code inside
 * the bundle (Next's compiled server) calls `require("fs")` etc. for
 * externalized node builtins, and esbuild's `__require` shim throws
 * `Dynamic require of "fs" is not supported` unless a real `require` is in
 * scope. workerd's `nodejs_compat` implements `node:module.createRequire`.
 *
 * The `?? "file:///"` fallback is load-bearing: `import.meta.url` is
 * `undefined` inside workerd modules, and a plain
 * `createRequire(import.meta.url)` crashes the worker at startup.
 */
export const CREATE_REQUIRE_BANNER = [
  `import { createRequire as __distilled_createRequire } from "node:module";`,
  `const require = /* @__PURE__ */ __distilled_createRequire(import.meta.url ?? "file:///");`,
].join("\n");

/**
 * OpenNext's `setWranglerExternal` esbuild plugin leaves `.wasm`/`.bin`
 * imports in the server handler as ABSOLUTE paths (optionally with a
 * `?module` suffix) "for wrangler to bundle". This plugin strips the suffix
 * and routes them through esbuild's `copy` loader so they become relative
 * file imports that can be registered as CompiledWasm/Data modules.
 */
export const makeWranglerExternalsPlugin = (): Esbuild.Plugin => ({
  name: "distilled-nextjs:wrangler-externals",
  setup(build) {
    build.onResolve({ filter: /\.(wasm|bin)(\?module)?$/ }, (args) => {
      const clean = args.path.replace(/\?module$/, "");
      return {
        path: NodePath.isAbsolute(clean)
          ? clean
          : NodePath.resolve(args.resolveDir, clean),
      };
    });
  },
});

export interface BundleWorkerOptions {
  /** The `.open-next` directory produced by the OpenNext build pipeline. */
  readonly openNextDirectory: string;
  /** Directory the finished module set is written to. */
  readonly outDirectory: string;
  /** Minify the emitted modules. @default false */
  readonly minify?: boolean | undefined;
}

export interface BundleWorkerResult {
  /** The esbuild metafile of the pass. */
  readonly metafile: Esbuild.Metafile;
}

/**
 * The "final bundle pass" wrangler normally performs at deploy time:
 * `.open-next/worker.js` (and its deliberately-unresolved relative imports —
 * `cloudflare/*.js`, `middleware/handler.mjs`, `.build/durable-objects/*.js`)
 * is bundled into a self-contained ESM module set.
 *
 * The four load-bearing rules (each discovered by a boot failure, not docs):
 *
 * 1. `format: "esm"` + `splitting: true` keeps the upstream
 *    `await import("./server-functions/default/handler.mjs")` a lazy chunk.
 * 2. `conditions: ["workerd", "worker"]` resolves workerd-flavored exports.
 * 3. `external: ["cloudflare:*", "node:*"]` — provided by workerd and
 *    `nodejs_compat` respectively.
 * 4. {@link CREATE_REQUIRE_BANNER} per output file (see its doc).
 *
 * Plus the `.wasm`/`.bin` `?module` copy rule
 * ({@link makeWranglerExternalsPlugin}).
 */
export const bundleWorker = (
  options: BundleWorkerOptions,
): Effect.Effect<BundleWorkerResult, BundleError> =>
  Effect.gen(function* () {
    const esbuild = yield* Effect.tryPromise({
      try: async () => await import("esbuild"),
      catch: (cause) =>
        new BundleError({ message: "Failed to load esbuild", cause }),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        esbuild.build({
          // Pin the build's working directory: without it, esbuild uses its
          // long-lived shared service process's cwd, which is captured when
          // the service first spawns — under a concurrent engine that can be
          // another build's transient chdir target (possibly deleted by the
          // time this build runs), which fails resolution of even absolute
          // entry paths.
          absWorkingDir: options.openNextDirectory,
          plugins: [makeWranglerExternalsPlugin()],
          entryPoints: [
            NodePath.join(options.openNextDirectory, WORKER_ENTRY_NAME),
          ],
          outdir: options.outDirectory,
          bundle: true,
          format: "esm",
          platform: "node",
          target: "es2022",
          conditions: ["workerd", "worker"],
          splitting: true,
          minify: options.minify ?? false,
          sourcemap: false,
          metafile: true,
          external: ["cloudflare:*", "node:*"],
          loader: {
            ".wasm": "copy",
            ".bin": "copy",
          },
          entryNames: "[name]",
          chunkNames: "chunks/[name]-[hash]",
          assetNames: "[name]-[hash]",
          banner: {
            js: CREATE_REQUIRE_BANNER,
          },
          logLevel: "silent",
        }),
      catch: (cause) =>
        new BundleError({
          message: "The final worker bundle pass failed",
          cause,
        }),
    });
    return { metafile: result.metafile };
  });

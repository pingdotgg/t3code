import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { pathToFileURL } from "node:url";
import {
  loadProjectModule,
  resolveProjectPackageDirectory,
  type ModuleLoadError,
} from "../core/Loader.ts";
import {
  loadVinextBuildConfig,
  type VinextBuildConfig,
} from "./BuildConfig.ts";

export type VinextPrerenderResult = {
  readonly ran: boolean;
  /** Absolute path of the RSC worker entry after path-table injection. */
  readonly entryPath?: string;
};

const PATH_TABLE_START = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
const PATH_TABLE_END = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";

const exists = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));

/**
 * The KV data-cache adapter throws during local prerender (no Worker
 * `env`) and vinext may log a wrangler.jsonc snippet. That hint is
 * wrong on the Alchemy path — drop those lines so deploy logs do not
 * look like a missing Wrangler file.
 */
const isWranglerKvHint = (text: string) =>
  text.includes("failed to initialize the configured data cache adapter") ||
  text.includes("Add it to wrangler.jsonc") ||
  (text.includes("KV data cache adapter requires") &&
    text.includes("KV namespace binding")) ||
  text.includes('"kv_namespaces"');

const withLocalPrerenderLogs = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      };
      const filter =
        (write: typeof console.log) =>
        (...args: Array<unknown>) => {
          const text = args.map((arg) => String(arg)).join(" ");
          if (isWranglerKvHint(text)) return;
          write(...args);
        };
      console.log = filter(original.log);
      console.warn = filter(original.warn);
      console.error = filter(original.error);
      console.info = filter(original.info);
      return original;
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
        console.info = original.info;
      }),
  );

/**
 * After `vite build`, run vinext's prerender phase when the project
 * configured `vinext({ prerender: true })` (or `{ routes: "*" }`).
 *
 * Alchemy's Website Vite path only runs `vite build`, which vinext does
 * not prerender by itself — that step lives in `vinext build`. This hook
 * is not a reimplementation: it resolves the project's `vinext` and calls
 * `runPrerender` / `emitPrerenderPathManifest`. The path-table injection
 * is the only Alchemy-owned glue.
 */
export const runVinextPrerenderIfConfigured = Effect.fn(function* (
  rootDir: string,
  cache: "kv" | "redis" | "s3" = "kv",
  buildConfig?: VinextBuildConfig,
) {
  const path = yield* Path.Path;
  const root = path.resolve(rootDir);
  const vinextRoot = yield* resolveVinextRoot(root);

  const importVinextDist = (rel: string) =>
    Effect.promise(
      () => import(pathToFileURL(path.join(vinextRoot, rel)).href),
    );

  const { resolveVinextPrerenderDecision, formatVinextPrerenderLabel } =
    yield* importVinextDist("dist/config/prerender.js");
  const config =
    buildConfig ??
    (yield* Effect.gen(function* () {
      const vite = yield* loadProjectModule<typeof import("vite")>(
        root,
        "vite",
      );
      const loaded = yield* Effect.tryPromise(() =>
        vite.loadConfigFromFile(
          { command: "build", mode: "production" },
          undefined,
          root,
        ),
      );
      return yield* loadVinextBuildConfig(root, loaded?.config.plugins);
    }));
  const decision = resolveVinextPrerenderDecision({
    vinextPrerenderConfig: config.prerenderConfig,
    nextOutput: config.nextConfig.output,
  });
  if (!decision) {
    return { ran: false } satisfies VinextPrerenderResult;
  }

  yield* Console.log(`  ${formatVinextPrerenderLabel(decision)}`);
  if (cache === "kv") {
    yield* Console.log(
      "  Local prerender has no Worker bindings. VINEXT_KV_CACHE is provisioned and seeded on deploy; do not add wrangler.jsonc.",
    );
  }

  const { runPrerender, assertNoFatalPrerenderRoutes } =
    (yield* importVinextDist("dist/build/run-prerender.js")) as {
      runPrerender: (options: {
        root: string;
        nextConfig: unknown;
        routeRootConfig: unknown;
      }) => Promise<{ routes?: readonly unknown[] } | null>;
      assertNoFatalPrerenderRoutes: (routes: readonly unknown[]) => void;
    };
  const prerenderResult = yield* withLocalPrerenderLogs(
    Effect.promise(() =>
      runPrerender({
        root,
        nextConfig: config.nextConfig,
        routeRootConfig: config.routeRootConfig,
      }),
    ),
  );
  if (prerenderResult?.routes) {
    assertNoFatalPrerenderRoutes(prerenderResult.routes);
  }

  const { emitPrerenderPathManifest } = yield* importVinextDist(
    "dist/build/prerender-paths.js",
  );
  yield* Effect.promise(() =>
    emitPrerenderPathManifest({
      root,
      nextConfig: config.nextConfig,
      routeRootConfig: config.routeRootConfig,
      buildIdentity: config.buildIdentity,
      responseVary: config.responseVary,
      requestRouting: config.requestRouting,
      isResponsePolicyHeader: config.isResponsePolicyHeader,
    }),
  );
  yield* injectPregeneratedConcretePaths(root);

  const fs = yield* FileSystem.FileSystem;
  const entryPath = path.join(root, "dist", "server", "index.js");
  return {
    ran: true,
    entryPath: (yield* exists(fs, entryPath)) ? entryPath : undefined,
  } satisfies VinextPrerenderResult;
});

/** Absolute path to the project's `vinext` package root. */
export const resolveVinextRoot = (
  root: string,
): Effect.Effect<string, ModuleLoadError> =>
  resolveProjectPackageDirectory(root, "vinext");

const injectPregeneratedConcretePaths = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const workerEntry = path.join(root, "dist", "server", "index.js");
    if (!(yield* exists(fs, workerEntry))) {
      return;
    }

    const escapedStart = PATH_TABLE_START.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const escapedEnd = PATH_TABLE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");

    let code = (yield* fs.readFileString(workerEntry)).replace(re, "");
    const manifestPath = path.join(
      root,
      "dist",
      "server",
      "vinext-prerender.json",
    );
    if (!(yield* exists(fs, manifestPath))) {
      yield* fs.writeFileString(workerEntry, code);
      return;
    }

    const manifest = JSON.parse(yield* fs.readFileString(manifestPath)) as {
      pregeneratedConcretePaths?: unknown;
    };
    const table = manifest.pregeneratedConcretePaths ?? [];
    if (Array.isArray(table) && table.length > 0) {
      code =
        `${PATH_TABLE_START}\n` +
        `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n` +
        `${PATH_TABLE_END}\n` +
        code;
    }
    yield* fs.writeFileString(workerEntry, code);
  });

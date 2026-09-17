import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import fg from "fast-glob";
import path from "pathe";
import * as Artifacts from "../../../Artifacts.ts";
import * as Bundle from "../../../Bundle/Bundle.ts";
import { sha256 } from "../../../Util/sha256.ts";
import type { SourceProvider } from "../Source.ts";
import {
  bundleSource,
  resolveMainPath,
  watchBundleDirectory,
} from "./shared.ts";

/**
 * A rule selecting additional module files to upload alongside the entry
 * of a prebuilt Worker (`bundle: false`). Globs are matched against
 * POSIX-style paths relative to the directory containing the Worker's
 * entry module, mirroring Wrangler's `rules` configuration.
 */
export interface ModuleRule {
  readonly globs: readonly string[];
}

/**
 * The default {@link ModuleRule | module rules} applied when
 * `bundle: false` is set without explicit rules — the same set Wrangler
 * applies to `no_bundle` Workers: ESModule (`**\/*.js`, `**\/*.mjs`),
 * CompiledWasm (`**\/*.wasm`), Text (`**\/*.txt`, `**\/*.html`,
 * `**\/*.sql`), and Data (`**\/*.bin`). Source maps (`.js.map`) are
 * deliberately not uploaded.
 */
export const defaultModuleRules: ModuleRule[] = [
  { globs: ["**/*.js", "**/*.mjs"] },
  { globs: ["**/*.wasm"] },
  { globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { globs: ["**/*.bin"] },
];

export interface PrebuiltWorkerBundleOptions {
  /**
   * Path (or `file://` URL) to the prebuilt, runtime-ready entry module.
   */
  main: string;
  /**
   * Module rules selecting additional files to upload alongside the
   * entry. Defaults to {@link defaultModuleRules}.
   */
  rules?: readonly ModuleRule[] | undefined;
}

/**
 * Read a prebuilt Worker bundle from disk without bundling.
 *
 * The entry's directory is walked recursively and every file matching the
 * rule globs is uploaded byte-for-byte as an additional module, named by
 * its POSIX path relative to that directory — the same contract as
 * Wrangler's `find_additional_modules` and Alchemy v1's `noBundle`. The
 * entry file is always first and never duplicated as an additional
 * module.
 */
export const readPrebuiltWorkerBundle = Effect.fn(function* (
  options: PrebuiltWorkerBundleOptions,
) {
  const fs = yield* FileSystem.FileSystem;

  // Resolve without following symlinks (Alchemy v1 parity): the module
  // walk happens in the directory the user pointed at, not the entry's
  // canonical location.
  const main = yield* resolveMainPath(options.main);
  const root = path.dirname(main);
  const entryName = path.basename(main);

  const readModuleFile = Effect.fn(function* (name: string) {
    const file = path.join(root, name);
    const content = yield* fs.readFile(file).pipe(
      Effect.mapError(
        (cause) =>
          new Bundle.BundleError({
            message: `Failed to read prebuilt worker bundle module "${file}"`,
            cause,
          }),
      ),
    );
    const hash = yield* sha256(content);
    return { path: name, content, hash } satisfies Bundle.BundleFile;
  });

  return yield* readModuleFile(entryName).pipe(
    Effect.zipWith(
      Effect.tryPromise({
        try: () =>
          fg.glob(
            (options.rules ?? defaultModuleRules).flatMap((rule) => rule.globs),
            {
              cwd: root,
              onlyFiles: true,
              dot: true,
            },
          ),
        catch: (error) =>
          new Bundle.BundleError({
            message: `Failed to read additional modules in directory "${root}"`,
            cause: error,
          }),
      }).pipe(
        Effect.map((names) =>
          names
            .map((name) => name.replaceAll("\\", "/"))
            .filter((name) => name !== entryName)
            .sort(),
        ),
        Effect.flatMap(
          Effect.forEach(readModuleFile, { concurrency: "unbounded" }),
        ),
      ),
      (entryModule, additionalModules) =>
        [entryModule, ...additionalModules] as [
          Bundle.BundleFile,
          ...Bundle.BundleFile[],
        ],
      { concurrent: true },
    ),
    Effect.flatMap(Bundle.bundleOutputFromFiles),
  );
});

/**
 * Watch a prebuilt Worker (`bundle: false`) for changes: emits the
 * initial byte-for-byte read, then re-reads whenever a file under the
 * entry's directory changes (debounced). Mirrors the
 * {@link Bundle.BundleWatchEvent} protocol of the rolldown watcher so
 * local dev can consume either stream interchangeably — crucially
 * WITHOUT re-bundling the prebuilt artifact, preserving the same
 * byte-for-byte contract as the deploy path.
 */
export const watchPrebuiltWorkerBundle = (
  options: PrebuiltWorkerBundleOptions,
) =>
  watchBundleDirectory({
    main: options.main,
    read: readPrebuiltWorkerBundle(options),
  });

/**
 * Source provider for prebuilt workers (`bundle: false`): the entry and
 * every file matching the module rules are uploaded byte-for-byte — no
 * bundling, no minification. `hash()` is a cheap re-read (IO + sha256,
 * no bundling), cached per run under the shared `"build"` artifact key.
 *
 * Local dev honors the same byte-for-byte contract: the entry directory
 * is fs-watched and re-read on change — never re-bundled with rolldown,
 * which would violate the prebuilt contract ("re-bundling such artifacts
 * is unsafe").
 */
export const makePrebuiltSource = (options: {
  main: string;
  rules: ModuleRule[] | undefined;
}): SourceProvider => {
  const build = readPrebuiltWorkerBundle({
    main: options.main,
    rules: options.rules,
  }).pipe(Artifacts.cached("build"));
  return bundleSource({
    build: () => build,
    watch: () =>
      Effect.succeed(
        watchPrebuiltWorkerBundle({
          main: options.main,
          rules: options.rules,
        }),
      ),
  });
};

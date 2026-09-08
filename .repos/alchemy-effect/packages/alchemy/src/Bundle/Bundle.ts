import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import assert from "node:assert";
import type * as rolldown from "rolldown";
import { sha256, sha256Object } from "../Util/sha256.ts";
import {
  bundleAnalyzerPlugin,
  type BundleAnalyzerPluginOptions,
} from "./BundleAnalyzerPlugin.ts";
import { purePlugin, type PurePluginOptions } from "./PurePlugin.ts";
import { rawPlugin } from "./RawPlugin.ts";

/**
 * `resolve.conditionNames` for a bundle that runs on bun / node.
 *
 * Rolldown's DEFAULT conditions are import-kind specific: `import` for
 * `import` statements and `require` for `require()` calls. An explicit
 * `conditionNames` list is applied as one set to BOTH kinds, and rolldown
 * adds only the current kind on top. Listing `"import"` here therefore
 * made every `require()` also match a package's `"import"` export — and
 * `exports` maps are matched in the PACKAGE's key order, so for `pg-pool`
 * (`{ import, require }`) a `require("pg-pool")` received the ESM namespace
 * and `pg` died with `TypeError: The superclass is not a constructor`.
 *
 * So: never put `import` or `require` in these lists. Only the runtime
 * condition and the kind-agnostic ones; rolldown supplies the kind.
 */
export const BUN_CONDITION_NAMES: readonly string[] = [
  "bun",
  "module",
  "default",
];
export const NODE_CONDITION_NAMES: readonly string[] = [
  "node",
  "module",
  "default",
];

/**
 * Rolldown is loaded lazily on first {@link build}/{@link watch} so that
 * merely importing alchemy — the CLI command tree, the Cloudflare provider
 * barrel — never loads `@rolldown/binding-*`. A stack that bundles
 * nothing must not require the native bundler to be loadable (#562).
 */
const loadRolldown = () => import("rolldown");

/**
 * Extra options accepted by {@link build} / {@link watch} on top of the
 * standard rolldown input/output options.
 */
export interface BundleExtraOptions {
  /**
   * Configures the {@link purePlugin} which annotates top-level
   * call/new expressions in matching packages with `/*#__PURE__*\/`
   * so rolldown can tree-shake them.
   *
   * - `undefined` (default): plugin is enabled with the default packages
   *   (`effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`,
   *   `@distilled.cloud/*` — see `DEFAULT_PURE_PACKAGES`).
   * - `PurePluginOptions`: plugin is enabled with the provided options.
   *   `packages` extends the defaults; set `replaceDefaults: true` to
   *   replace them instead.
   * - `false`: plugin is disabled.
   */
  readonly pure?: PurePluginOptions | false;
  /**
   * Configures the {@link bundleAnalyzerPlugin} which emits a bundle analysis
   * report alongside the bundle output, describing chunks, modules, and the
   * import graph reachable from each entry point.
   *
   * - `undefined` / `false` (default): plugin is disabled.
   * - `true`: plugin is enabled with default options.
   * - `BundleAnalyzerPluginOptions`: plugin is enabled with the provided options.
   */
  readonly bundleAnalyzer?: BundleAnalyzerPluginOptions | boolean;
}

/**
 * The user-facing bundler configuration shared by every resource that
 * bundles an entrypoint with rolldown (AWS Lambda Function, Batch
 * JobDefinition, App Runner Service, ECR image sources, EC2 hosted
 * instances, Docker service images, Cloudflare container images, …):
 * rolldown input/output overrides plus the {@link BundleExtraOptions}
 * (pure-annotation packages via `pure`, bundle analyzer).
 *
 * Top-level calls in `effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`,
 * and `@distilled.cloud/*` are annotated as pure by default so unused
 * code from those packages is tree-shaken out of the bundle; list
 * additional packages via `pure.packages`, or disable annotation with
 * `pure: false`.
 */
export interface BundleConfig extends BundleExtraOptions {
  /**
   * Rolldown input options overrides.
   */
  readonly input?: Partial<rolldown.InputOptions>;
  /**
   * Rolldown output options overrides.
   */
  readonly output?: Partial<rolldown.OutputOptions>;
}

export interface BundleOutput {
  /**
   * The files in the bundle.
   * The first file is the entry.
   */
  readonly files: [BundleFile, ...BundleFile[]];
  /**
   * The SHA-256 hash of all files in the bundle.
   */
  readonly hash: string;
}

export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array<ArrayBufferLike>;
  readonly hash: string;
}

export class BundleError extends Schema.TaggedError<BundleError>()(
  "BundleError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect({ includeStack: true })),
  },
) {}

export type BundleWatchEvent =
  | BundleWatchEvent.Start
  | BundleWatchEvent.Success
  | BundleWatchEvent.Error;

export declare namespace BundleWatchEvent {
  interface Start {
    readonly _tag: "Start";
  }
  interface Success {
    readonly _tag: "Success";
    readonly output: BundleOutput;
  }
  interface Error {
    readonly _tag: "Error";
    readonly error: BundleError;
  }
}

/**
 * Compile-time constants substituted into every bundle via rolldown's
 * `transform.define`.
 *
 * `globalThis.__ALCHEMY_RUNTIME__` is the runtime-phase flag: it is folded to
 * `true` in all bundled (runtime) artifacts — deployed Workers, Lambdas,
 * Containers, etc. — so any plan-only code guarded by
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` becomes `if (!true)` and is
 * dead-code-eliminated from what ships.
 *
 * When the same source runs WITHOUT the bundler (the plan process executing
 * `.ts` directly with bun/node), `globalThis.__ALCHEMY_RUNTIME__` reads as
 * `undefined` (falsy) rather than throwing, so plan-only branches run.
 * See `ALCHEMY_PHASE` in `Phase.ts`.
 */
const ALCHEMY_DEFINE: Record<string, string> = {
  "globalThis.__ALCHEMY_RUNTIME__": "true",
};

/**
 * Default rolldown `moduleTypes` applied to every bundle, mirroring the
 * `Text` module rules Wrangler applies to Workers (and alchemy's own
 * {@link defaultModuleRules} for prebuilt bundles): importing a `.sql`,
 * `.txt`, or `.html` file default-exports its contents as a string.
 *
 * `.sql` is what makes drizzle-kit's generated Durable Object migrations
 * bundle (`migrations.js` does `import m0000 from './0000_x.sql'`) work
 * without a wrangler-style rules config or a codegen step.
 */
const ALCHEMY_MODULE_TYPES: NonNullable<rolldown.InputOptions["moduleTypes"]> =
  {
    ".sql": "text",
    ".txt": "text",
    ".html": "text",
  };

/**
 * Merge {@link ALCHEMY_DEFINE} into the caller's `transform.define` (the
 * framework flags win over any caller-provided keys) and
 * {@link ALCHEMY_MODULE_TYPES} into the caller's `moduleTypes` (caller
 * keys win, so an extension can be remapped or disabled per bundle).
 */
const withAlchemyDefine = (
  inputOptions: rolldown.InputOptions,
): rolldown.InputOptions => ({
  ...inputOptions,
  transform: {
    ...inputOptions.transform,
    define: {
      ...inputOptions.transform?.define,
      ...ALCHEMY_DEFINE,
    },
  },
  moduleTypes: {
    ...ALCHEMY_MODULE_TYPES,
    ...inputOptions.moduleTypes,
  },
});

/**
 * Default `minify` to `"dce-only"` when the caller hasn't chosen a mode, so the
 * `if (false) { … }` branches produced by {@link ALCHEMY_DEFINE} are physically
 * removed from every bundle (define alone only folds the condition; removal
 * needs DCE). Callers that opt into full minification (e.g. Workers) keep it.
 */
const withDceDefault = (
  outputOptions?: rolldown.OutputOptions,
): rolldown.OutputOptions => ({
  ...outputOptions,
  minify: outputOptions?.minify ?? "dce-only",
});

/**
 * Build a bundle using rolldown from the given input options and output options.
 * @param inputOptions - The input options for the bundle.
 * @param outputOptions - The output options for the bundle.
 * @returns The bundle output.
 */
export const build = (
  inputOptions: rolldown.InputOptions,
  outputOptions?: rolldown.OutputOptions,
  extra?: BundleExtraOptions,
): Effect.Effect<BundleOutput, BundleError> =>
  Effect.tryPromise({
    try: async () => {
      const rolldown = await loadRolldown();
      const bundle = await rolldown.rolldown({
        ...withAlchemyDefine(inputOptions),
        plugins: [inputOptions.plugins, await builtInPlugins(extra)],
        optimization: inputOptions.optimization ?? {
          inlineConst: {
            mode: "smart",
            pass: 3,
          },
        },
      });
      const result = await bundle.write(withDceDefault(outputOptions));
      await bundle.close();
      return result.output;
    },
    catch: bundleErrorFromUnknown,
  }).pipe(
    Effect.flatMap(Effect.forEach(bundleFileFromOutputChunk)),
    Effect.flatMap(bundleOutputFromFiles),
  );

/**
 * Watch for changes in the bundle and return a stream of bundle output.
 * @param inputOptions - The input options for the bundle.
 * @param outputOptions - The output options for the bundle.
 * @returns A stream of Result instances containing either the bundle output or an error.
 */
export const watch = (
  inputOptions: rolldown.InputOptions,
  outputOptions?: rolldown.OutputOptions,
  extra?: BundleExtraOptions,
): Stream.Stream<BundleWatchEvent> =>
  Stream.callback<
    | BundleWatchEvent.Start
    | BundleWatchEvent.Error
    | {
        readonly _tag: "Success";
        readonly output: rolldown.OutputBundle;
      }
  >((queue) =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        const rolldown = await loadRolldown();
        const watcher = rolldown.watch({
          ...withAlchemyDefine(inputOptions),
          plugins: [
            inputOptions.plugins,
            await builtInPlugins(extra),
            // The watcher event listener does not receive the bundle output, so we grab it using a plugin.
            {
              name: "alchemy:watch-bundle",
              watchChange() {
                Queue.offerUnsafe(queue, {
                  _tag: "Start",
                });
              },
              generateBundle(_outputOptions, bundle) {
                Queue.offerUnsafe(queue, {
                  _tag: "Success",
                  output: bundle,
                });
              },
            },
          ],
          watch: {
            // Watching the full module graph of an Effect worker (all of
            // `effect`, `alchemy`, `@distilled.cloud/*`) registers thousands
            // of OS watch handles *per worker*; with several Effect workers
            // this exhausts the process fd table and the next `posix_spawn`
            // (workerd / docker) fails with `spawn EBADF`. Workspace packages
            // resolve to their real source paths (outside `node_modules`), so
            // they stay watched and local HMR is unaffected.
            exclude: ["**/node_modules/**"],
          },
          output: withDceDefault(outputOptions),
        });
        watcher.on("event", (event) => {
          if (event.code === "ERROR") {
            Queue.offerUnsafe(queue, {
              _tag: "Error",
              error: bundleErrorFromUnknown(event.error),
            });
          } else if (event.code === "BUNDLE_END") {
            // This must be called to avoid resource leaks.
            event.result.close().catch(() => {});
          }
        });
        return watcher;
      }),
      (watcher) => Effect.promise(() => watcher.close()),
    ),
  ).pipe(
    Stream.mapEffect((event) =>
      Effect.gen(function* () {
        if (event._tag !== "Success") {
          return event;
        }
        return yield* bundleOutputFromRolldownOutputBundle(event.output).pipe(
          Effect.map((output): BundleWatchEvent.Success => ({
            _tag: "Success",
            output,
          })),
          Effect.catch((error) =>
            Effect.succeed<BundleWatchEvent.Error>({
              _tag: "Error",
              error: bundleErrorFromUnknown(error),
            }),
          ),
        );
      }),
    ),
  );

const ENTRY_PREFIX = "\0virtual:alchemy-entry:";
// oxlint-disable-next-line no-control-regex
const ENTRY_REGEX = /^\0virtual:alchemy-entry:/;
/**
 * Ids the `resolveId` hook looks at: the virtual entry ids themselves, plus
 * bare package specifiers (not starting with `.`, `/` or `\0`) so an
 * unresolvable import in a generated entry fails the build (below).
 */
// oxlint-disable-next-line no-control-regex
const ENTRY_OR_BARE_REGEX = /^(?:\0virtual:alchemy-entry:|[^./\0])/;

export const virtualEntryPlugin = Effect.gen(function* () {
  const path = yield* Path.Path;

  const normalizeInput = (
    input: rolldown.InputOption,
  ): Record<string, string> => {
    if (typeof input === "string") {
      return { [path.parse(input).name || "index"]: input };
    } else if (Array.isArray(input)) {
      return Object.fromEntries(input.map((p) => [path.parse(p).name, p]));
    } else {
      return input;
    }
  };

  return (content: (importPath: string) => string) => {
    const entries = new Map<string, string>();
    return {
      name: "alchemy:virtual-entry",
      options: {
        order: "pre",
        handler(inputOptions) {
          const cwd = inputOptions.cwd ?? process.cwd();
          const input = normalizeInput(inputOptions.input ?? {});
          inputOptions.input = Object.fromEntries(
            Object.entries(input).map(([name, p]) => {
              const id = `${ENTRY_PREFIX}${name}`;
              entries.set(id, path.resolve(cwd, p));
              return [name, id];
            }),
          );
        },
      },
      resolveId: {
        filter: { id: ENTRY_OR_BARE_REGEX },
        async handler(id, importer) {
          if (ENTRY_REGEX.test(id)) {
            return entries.has(id) ? { id } : null;
          }
          // A bare import made BY a generated entry. Rolldown only WARNS on
          // an unresolved import and leaves it external, which for a
          // generated entry means the deployed process dies at boot with
          // `Cannot find module` — the class of bug the shim design
          // (alchemy/Runtime/Bootstrap/*) exists to prevent. Make it a build
          // error with the cause spelled out instead. Externals resolve to
          // `{ external: true }`, not null, so they pass through.
          if (importer === undefined || !ENTRY_REGEX.test(importer)) {
            return null;
          }
          const resolved = await this.resolve(id, importer, {
            skipSelf: true,
          });
          if (resolved === null) {
            const entry = entries.get(importer);
            this.error(
              new Error(
                `The generated entry for ${entry} imports "${id}", which cannot be resolved from the project. ` +
                  "A generated entry may only import `alchemy/*` (resolvable from any project that depends on alchemy) and the entry itself; " +
                  "check that `alchemy` is installed in the project containing the entry.",
              ),
            );
          }
          return resolved;
        },
      },
      load: {
        filter: { id: ENTRY_REGEX },
        handler(id) {
          const entry = entries.get(id);
          assert(entry !== undefined, `unknown alchemy entry: ${id}`);
          return {
            code: content(entry),
            moduleType: "ts",
          };
        },
      },
    } satisfies rolldown.Plugin;
  };
});

export function bundleOutputFromRolldownOutputBundle(
  bundle: rolldown.OutputBundle,
): Effect.Effect<BundleOutput, BundleError> {
  const files = Object.values(bundle);
  // These are sanity checks - with rolldown, the first file is always an entry chunk.
  if (!files[0] || files[0].type !== "chunk" || !files[0].isEntry) {
    return Effect.fail(
      new BundleError({
        message: "Invalid bundle output",
      }),
    );
  }
  return Effect.forEach(
    files as [
      rolldown.OutputChunk,
      ...(rolldown.OutputChunk | rolldown.OutputAsset)[],
    ],
    bundleFileFromOutputChunk,
  ).pipe(Effect.flatMap(bundleOutputFromFiles));
}

/**
 * Returns the built-in plugins appended after the user-provided plugin chain,
 * configured by {@link BundleExtraOptions}.
 *
 * These run LAST so they see module ids that have already been resolved into
 * `node_modules/<pkg>/...` by upstream resolver plugins such as
 * `@alchemy.run/cloudflare-runtime/rolldown`.
 */
async function builtInPlugins(
  extra?: BundleExtraOptions,
): Promise<rolldown.RolldownPluginOption> {
  return [
    extra?.bundleAnalyzer
      ? await bundleAnalyzerPlugin(
          extra.bundleAnalyzer === true ? {} : extra.bundleAnalyzer,
        )
      : undefined,
    extra?.pure !== false ? purePlugin(extra?.pure ?? {}) : undefined,
    rawPlugin(),
  ];
}

export function bundleErrorFromUnknown(error: unknown): BundleError {
  const message = error instanceof Error ? error.message : String(error);
  return new BundleError({
    message,
    cause: error,
  });
}

export function bundleOutputFromFiles(
  files: [BundleFile, ...BundleFile[]],
): Effect.Effect<BundleOutput> {
  return Effect.map(
    sha256Object(
      files.map((file) => ({
        path: file.path,
        hash: file.hash,
      })),
    ),
    (hash) => ({ files, hash }),
  );
}

function bundleFileFromOutputChunk(
  chunk: rolldown.OutputChunk | rolldown.OutputAsset,
): Effect.Effect<BundleFile> {
  switch (chunk.type) {
    case "chunk":
      return Effect.map(sha256(chunk.code), (hash) => ({
        path: chunk.fileName,
        content: chunk.code,
        hash,
      }));
    case "asset":
      return Effect.map(sha256(chunk.source), (hash) => ({
        path: chunk.fileName,
        content: chunk.source,
        hash,
      }));
  }
}

import assert from "node:assert";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import { dotAlchemyDirectory } from "../AlchemyContext.ts";
import { encodeFqn } from "../FQN.ts";
import { ResourceContext } from "../ResourceContext.ts";
import { StackContext } from "../StackContext.ts";
import { LogAnnotation } from "../Util/LogAnnotation.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import { bundleAnalyzerPlugin, type BundleAnalyzerPluginOptions } from "./BundleAnalyzerPlugin.ts";
import { namespaceImportPlugin } from "./NamespaceImportPlugin.ts";
import { purePlugin, type PurePluginOptions } from "./PurePlugin.ts";
import { rawPlugin } from "./RawPlugin.ts";
import { unreachableChunksPlugin } from "./UnreachableChunksPlugin.ts";

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
export const BUN_CONDITION_NAMES: readonly string[] = ["bun", "module", "default"];
export const NODE_CONDITION_NAMES: readonly string[] = ["node", "module", "default"];

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
   * import graph reachable from each entry point. The report is written next
   * to the bundle (see {@link BundleConfig.output}).
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
 * Unused code is tree-shaken. `effect`, alchemy, and `@distilled.cloud`
 * are marked pure so unused parts prune more aggressively. List extra
 * packages with `pure.packages`, or disable with `pure: false`.
 */
export interface BundleConfig extends BundleExtraOptions {
  /**
   * Rolldown input options overrides.
   */
  readonly input?: Partial<rolldown.InputOptions>;
  /**
   * Rolldown output options overrides.
   *
   * The bundle is written to `.alchemy/bundles/<stack>-<stage>-<resource>`,
   * which is cleared before every build, so you can inspect exactly what
   * ships. Set `dir` or `file` to write it somewhere else; Alchemy never
   * clears a directory you choose.
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
  /**
   * The platform's module type for this file, when its extension doesn't
   * decide it (e.g. a Cloudflare `Text` rule over `.md` files).
   */
  readonly type?: string;
}

export class BundleError extends Schema.TaggedError<BundleError>()("BundleError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect({ includeStack: true })),
}) {}

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
const ALCHEMY_MODULE_TYPES: NonNullable<rolldown.InputOptions["moduleTypes"]> = {
  ".sql": "text",
  ".txt": "text",
  ".html": "text",
};

/**
 * Merge {@link ALCHEMY_DEFINE} into the caller's `transform.define` (the
 * framework flags win over any caller-provided keys) and
 * {@link ALCHEMY_MODULE_TYPES} into the caller's `moduleTypes` (caller
 * keys win, so an extension can be remapped or disabled per bundle).
 *
 * Also enables `experimental.lazyBarrel` unless the caller sets it, so a
 * runtime importing one service from `@alchemy.run/aws` (a barrel of every
 * AWS service) compiles that service, not all of them. See
 * {@link namespaceImportPlugin} for `import * as AWS`.
 */
const withAlchemyDefine = (inputOptions: rolldown.InputOptions): rolldown.InputOptions => ({
  ...inputOptions,
  experimental: {
    lazyBarrel: true,
    ...inputOptions.experimental,
  },
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
const withDceDefault = (outputOptions?: rolldown.OutputOptions): rolldown.OutputOptions => ({
  ...outputOptions,
  minify: outputOptions?.minify ?? "dce-only",
});

/** Whether the caller chose where the bundle is written (`dir` or `file`). */
export const hasOutputLocation = (outputOptions?: Partial<rolldown.OutputOptions>): boolean =>
  outputOptions?.dir !== undefined || outputOptions?.file !== undefined;

/**
 * The directory a resource's bundle is written to when its `output` sets
 * neither `dir` nor `file`: `.alchemy/bundles/<stack>-<stage>-<fqn>`, one flat
 * level under `bundles/` (namespace separators in the FQN become `__`). Every
 * resource gets its own directory, so concurrent stages never share one and
 * the directory can be cleared before each build.
 */
export const outputDirectory = (resource: {
  readonly stack: string;
  readonly stage: string;
  readonly fqn: string;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dotAlchemy = yield* dotAlchemyDirectory;
    // A relative `.alchemy` (standalone callers) stays relative, so rolldown
    // resolves it against the bundle `cwd` like any other output `dir`.
    return path.join(
      dotAlchemy,
      "bundles",
      `${resource.stack}-${resource.stage}-${encodeFqn(resource.fqn)}`,
    );
  });

/**
 * Resolve where a bundle is written:
 *
 * - `dir` or `file` set by the caller: rolldown writes there, as configured.
 * - Otherwise, inside a resource lifecycle operation (the engine provides
 *   {@link ResourceContext} and the stack): the resource's
 *   {@link outputDirectory}, cleared before each build so stale hashed
 *   chunks never pile up.
 * - Otherwise: the bundle stays in memory. Rolldown's default `dir` (`dist`,
 *   resolved against `cwd`) would leave an unused copy in the user's package.
 *
 * Callers always consume the bundle from memory; the copy on disk is for
 * inspecting what ships, the bundle analyzer report, and `writeBundle` hooks.
 */
const resolveOutputOptions = (outputOptions?: rolldown.OutputOptions) =>
  Effect.gen(function* () {
    const options = withDceDefault(outputOptions);
    if (hasOutputLocation(options)) return options;
    const resource = yield* Effect.serviceOption(ResourceContext);
    const stack = yield* Effect.serviceOption(StackContext);
    const path = yield* Effect.serviceOption(Path.Path);
    if (Option.isNone(resource) || Option.isNone(stack) || Option.isNone(path)) return options;
    const dir = yield* outputDirectory({
      stack: stack.value.name,
      stage: stack.value.stage,
      fqn: resource.value.fqn,
    }).pipe(Effect.provideService(Path.Path, path.value));
    return { ...options, dir, cleanDir: true } satisfies rolldown.OutputOptions;
  });

/**
 * Process-wide limit on concurrent rolldown builds (one-shot builds and each
 * watcher's initial build). Every build holds the full module graph in native
 * memory, so an unbounded burst (a stack deploying dozens of functions, or a
 * dev session starting one watcher per function) peaks at gigabytes of RSS.
 * Override with `ALCHEMY_BUNDLE_CONCURRENCY`.
 */
const bundleConcurrency = (() => {
  const configured = Number(process.env.ALCHEMY_BUNDLE_CONCURRENCY);
  return Number.isInteger(configured) && configured > 0 ? configured : 4;
})();
const buildPermits = Semaphore.makeUnsafe(bundleConcurrency);

/**
 * Rolldown's own logs (warnings such as `UNRESOLVED_IMPORT`, plugin timings)
 * as `output` records in the context of the build: the resource's `fqn` and
 * trace, one record per log instead of raw lines on stderr. Like any tool
 * output, they stay in the run log and are never exported. A caller's own
 * `onLog` wins.
 */
const withRolldownLogs = (
  inputOptions: rolldown.InputOptions,
  context: Context.Context<never>,
): rolldown.InputOptions =>
  inputOptions.onLog !== undefined
    ? inputOptions
    : {
        ...inputOptions,
        onLog: (level, log) =>
          Effect.runSyncWith(context)(
            Effect.logWithLevel(level === "warn" ? "Warn" : level === "debug" ? "Debug" : "Info")(
              log.frame === undefined ? log.message : `${log.message}\n${log.frame}`,
            ).pipe(
              Effect.annotateLogs({
                [LogAnnotation.stream]: "stderr",
                ...(log.code === undefined ? {} : { code: log.code }),
                ...(log.plugin === undefined ? {} : { plugin: log.plugin }),
              }),
            ),
          ),
      };

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
  Effect.zip(resolveOutputOptions(outputOptions), Effect.context<never>()).pipe(
    Effect.flatMap(([options, context]) =>
      Effect.tryPromise({
        try: async () => {
          const rolldown = await loadRolldown();
          const bundle = await rolldown.rolldown({
            ...withAlchemyDefine(withRolldownLogs(inputOptions, context)),
            plugins: [inputOptions.plugins, await builtInPlugins(extra)],
            optimization: inputOptions.optimization ?? {
              inlineConst: {
                mode: "smart",
                pass: 3,
              },
            },
          });
          const result = hasOutputLocation(options)
            ? await bundle.write(options)
            : await bundle.generate(options);
          await bundle.close();
          return result.output;
        },
        catch: bundleErrorFromUnknown,
      }).pipe(buildPermits.withPermits(1)),
    ),
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
  Stream.unwrap(
    Effect.zipWith(
      resolveOutputOptions(outputOptions),
      Effect.context<never>(),
      (options, context) => watchResolved(withRolldownLogs(inputOptions, context), extra)(options),
    ),
  );

const watchResolved =
  (inputOptions: rolldown.InputOptions, extra: BundleExtraOptions | undefined) =>
  (outputOptions: rolldown.OutputOptions): Stream.Stream<BundleWatchEvent> =>
    Stream.callback<
      | BundleWatchEvent.Start
      | BundleWatchEvent.Error
      | {
          readonly _tag: "Success";
          readonly output: rolldown.OutputBundle;
        }
    >((queue) => {
      const createWatcher = async (settle: () => void) => {
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
            // `generateBundle` still fires, so the output is captured either way.
            skipWrite: !hasOutputLocation(outputOptions),
          },
          output: outputOptions,
        });
        watcher.on("event", (event) => {
          if (event.code === "ERROR" || event.code === "BUNDLE_END") {
            settle();
          }
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
      };
      return Effect.acquireRelease(
        Effect.gen(function* () {
          // Hold a build permit until the watcher's initial build settles.
          yield* buildPermits.take(1);
          const context = yield* Effect.context();
          let initialBuildSettled = false;
          const settleInitialBuild = () => {
            if (initialBuildSettled) return;
            initialBuildSettled = true;
            Effect.runForkWith(context)(buildPermits.release(1));
          };
          const watcher = yield* Effect.promise(() => createWatcher(settleInitialBuild)).pipe(
            Effect.onError(() => Effect.sync(settleInitialBuild)),
          );
          return { watcher, settleInitialBuild };
        }),
        ({ watcher, settleInitialBuild }) =>
          Effect.promise(() => watcher.close()).pipe(
            Effect.ensuring(Effect.sync(settleInitialBuild)),
          ),
      );
    }).pipe(
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
const ENTRY_REGEX = /^\0virtual:alchemy-entry:/;
/**
 * Ids the `resolveId` hook looks at: the virtual entry ids themselves, plus
 * bare package specifiers (not starting with `.`, `/` or `\0`) so an
 * unresolvable import in a generated entry fails the build (below).
 */
const ENTRY_OR_BARE_REGEX = /^(?:\0virtual:alchemy-entry:|[^./\0])/;

export const virtualEntryPlugin = Effect.gen(function* () {
  const path = yield* Path.Path;

  const normalizeInput = (input: rolldown.InputOption): Record<string, string> => {
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
          // (`{Provider}/Bootstrap/*`) exists to prevent. Make it a build
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
                  "A generated entry may only import its bootstrap module (from `alchemy` or the provider package that generated it) and the entry itself; " +
                  "check that the package is installed in the project containing the entry.",
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
      BundleError.make({
        message: "Invalid bundle output",
      }),
    );
  }
  return Effect.forEach(
    files as [rolldown.OutputChunk, ...(rolldown.OutputChunk | rolldown.OutputAsset)[]],
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
async function builtInPlugins(extra?: BundleExtraOptions): Promise<rolldown.RolldownPluginOption> {
  return [
    extra?.bundleAnalyzer
      ? await bundleAnalyzerPlugin(extra.bundleAnalyzer === true ? {} : extra.bundleAnalyzer)
      : undefined,
    namespaceImportPlugin(),
    extra?.pure !== false ? purePlugin(extra?.pure ?? {}) : undefined,
    rawPlugin(),
    unreachableChunksPlugin(),
  ];
}

export function bundleErrorFromUnknown(error: unknown): BundleError {
  const message = error instanceof Error ? error.message : String(error);
  return BundleError.make({
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
        ...(file.type ? { type: file.type } : {}),
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

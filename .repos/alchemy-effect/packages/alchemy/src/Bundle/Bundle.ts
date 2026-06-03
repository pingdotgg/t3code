import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import assert from "node:assert";
import * as rolldown from "rolldown";
import { sha256, sha256Object } from "../Util/sha256.ts";
import {
  bundleAnalyzerPlugin,
  type BundleAnalyzerPluginOptions,
} from "./BundleAnalyzerPlugin.ts";
import { purePlugin, type PurePluginOptions } from "./PurePlugin.ts";
import { rawPlugin } from "./RawPlugin.ts";

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
   * - `undefined` (default): plugin is enabled with default packages
   *   (`effect`, `@effect/*`).
   * - `PurePluginOptions`: plugin is enabled with the provided options.
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

export class BundleError extends Schema.TaggedErrorClass<BundleError>()(
  "BundleError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.DefectWithStack),
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
      const bundle = await rolldown.rolldown({
        ...inputOptions,
        plugins: [inputOptions.plugins, builtInPlugins(extra)],
        optimization: inputOptions.optimization ?? {
          inlineConst: {
            mode: "smart",
            pass: 3,
          },
        },
      });
      const result = await bundle.write(outputOptions);
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
      Effect.sync(() => {
        const watcher = rolldown.watch({
          ...inputOptions,
          plugins: [
            inputOptions.plugins,
            builtInPlugins(extra),
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
          output: outputOptions,
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
          Effect.map(
            (output): BundleWatchEvent.Success => ({
              _tag: "Success",
              output,
            }),
          ),
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
        filter: { id: ENTRY_REGEX },
        handler(id) {
          return entries.has(id) ? { id } : null;
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
 * `@distilled.cloud/cloudflare-rolldown-plugin`.
 */
function builtInPlugins(
  extra?: BundleExtraOptions,
): rolldown.RolldownPluginOption {
  return [
    extra?.bundleAnalyzer
      ? bundleAnalyzerPlugin(
          extra.bundleAnalyzer === true ? {} : extra.bundleAnalyzer,
        )
      : undefined,
    extra?.pure !== false ? purePlugin(extra?.pure ?? {}) : undefined,
    rawPlugin(),
  ];
}

function bundleErrorFromUnknown(error: unknown): BundleError {
  const message = error instanceof Error ? error.message : String(error);
  return new BundleError({
    message,
    cause: error,
  });
}

function bundleOutputFromFiles(
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

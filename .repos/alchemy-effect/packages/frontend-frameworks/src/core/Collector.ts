import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as NodePath from "node:path";

/**
 * Module names in a BuildOutput are always POSIX-separated — they become
 * workerd module names and worker-upload paths, where `\` is never valid.
 * Filesystem paths stay platform-native; only names go through this.
 */
const toModuleName = (...segments: Array<string>): string =>
  NodePath.join(...segments).replaceAll("\\", "/");
import type * as Vite from "vite";
import {
  sortServerModules,
  toOutputFile,
  type BuildOutput,
  type OutputFile,
} from "./BuildOutput.ts";

export class CollectorError extends Data.TaggedError<"CollectorError">(
  "CollectorError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The synthetic module prefix `@alchemy.run/cloudflare-runtime/rolldown`
 * wraps worker entries with. Mirrored here (rather than imported) so the
 * collector has no runtime dependency on the plugin; an equality test guards
 * the constant against drift.
 */
export const WORKER_ENTRY_PREFIX = "\0distilled:worker-entry:";

// `@vitejs/plugin-rsc` writes these modules separately after build completes instead of emitting them as chunks.
// So, we need to detect them and read them from the file system manually.
const RSC_MANIFEST = {
  "virtual:vite-rsc/assets-manifest": "__vite_rsc_assets_manifest.js",
  "virtual:vite-rsc/environment-imports": "__vite_rsc_env_imports_manifest.js",
} as const;
type RscManifestId = keyof typeof RSC_MANIFEST;

const isRscManifestId = (id: string): id is RscManifestId => id in RSC_MANIFEST;

/** Files re-read from disk as text (everything else is read as binary). */
export const DEFAULT_TEXT_FILE_REGEX =
  /\.(m?js|cjs|json|txt|html|sql|map|css)$/;

/** The entry-chunk information {@link CollectorOptions.selectEntry} receives. */
export interface ServerEntryChunk {
  /** The emitted file name, relative to the environment's outDir. */
  readonly fileName: string;
  /** The server-module name (outDir prefix + fileName), as it appears in `serverModules`. */
  readonly name: string;
  /** The chunk's facade module id (the resolved input id), if any. */
  readonly facadeModuleId: string | null;
}

export interface CollectorOptions {
  /**
   * The environment whose entry chunk becomes `serverModules[0]`.
   * @default "ssr"
   */
  readonly entryEnvironment?: string | undefined;
  /**
   * The environment whose outDir becomes `clientDirectory`.
   * @default "client"
   */
  readonly clientEnvironment?: string | undefined;
  /**
   * Environments that must not contribute server modules (e.g. Astro's
   * node-side `prerender` environment, whose output is deleted after
   * prerendering completes).
   * @default []
   */
  readonly skipEnvironments?: ReadonlyArray<string> | undefined;
  /**
   * Pin the server entry when the entry environment emits multiple entry
   * chunks (e.g. Waku's rsc environment emits `index`, `build`, and the
   * wrapped worker entry). When omitted, a chunk whose facade is the wrapped
   * `\0distilled:worker-entry:` module is preferred; a chunk matched by this
   * predicate takes precedence over both.
   */
  readonly selectEntry?: ((chunk: ServerEntryChunk) => boolean) | undefined;
}

/**
 * Build a {@link CollectorOptions.selectEntry} predicate that pins the chunk
 * whose facade module is the given entry file — tolerating synthetic wrapper
 * ids that embed the resolved path (the `\0distilled:worker-entry:`-wrapped
 * main). Pair with `resolveDeployTargetEntry`: when a deploy target carries a
 * user entry ({@link DeployTargetEntry}), the chunk built from it must become
 * `serverModules[0]` even if the framework normally pins its own entry module.
 */
export const selectEntryByFacade = (
  entryPath: string,
): ((chunk: ServerEntryChunk) => boolean) => {
  const posixPath = NodePath.resolve(entryPath).replaceAll("\\", "/");
  return (chunk) =>
    chunk.facadeModuleId !== null &&
    chunk.facadeModuleId.replaceAll("\\", "/").endsWith(posixPath);
};

export interface CollectOptions {
  /**
   * Re-read the server environments' outDirs from disk instead of using the
   * in-memory `writeBundle` capture. Required for frameworks that write
   * additional server modules or rewrite chunks on disk *after* the bundler
   * finishes (e.g. Waku writes `__waku_build_metadata.js` and prunes
   * static-only chunks during `buildApp` hooks).
   * @default false
   */
  readonly fromDisk?: boolean | undefined;
  /**
   * Decides which on-disk files are read as text when `fromDisk` is set.
   * @default matches {@link DEFAULT_TEXT_FILE_REGEX}
   */
  readonly isTextFile?: ((fileName: string) => boolean) | undefined;
}

export interface BuildOutputCollector {
  /**
   * The Vite plugin. Add it to the build's plugins (it is shared across
   * environments); create a fresh collector per build.
   */
  readonly plugin: Vite.Plugin;
  /** Assemble the {@link BuildOutput} after `builder.buildApp()` resolves. */
  readonly collect: (
    options?: CollectOptions,
  ) => Effect.Effect<BuildOutput, CollectorError>;
}

/**
 * Create the `alchemy:build-output` collector: a Vite plugin that captures
 * the client directory, server modules (entry first, sha256-hashed), and
 * external workspace directories from a framework build.
 */
export const makeBuildOutputCollector = (
  options?: CollectorOptions,
): Effect.Effect<BuildOutputCollector, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const entryEnvironment = options?.entryEnvironment ?? "ssr";
    const clientEnvironment = options?.clientEnvironment ?? "client";
    const skipEnvironments = new Set(options?.skipEnvironments ?? []);
    const selectEntry = options?.selectEntry;

    let distDirectory: string | undefined;
    let clientDirectory: string | undefined;
    let serverEntry: string | undefined;
    let serverEntryPriority = 0;
    const serverModules = new Map<
      string,
      Effect.Effect<OutputFile, CollectorError>
    >();
    const serverOutputs = new Map<string, { root: string; outDir: string }>();
    const externalDirectories = new Set<string>();

    const readFile = (
      path: string,
      name: string,
    ): Effect.Effect<OutputFile, CollectorError> =>
      fs.readFileString(path).pipe(
        Effect.flatMap((content) => toOutputFile(name, content)),
        Effect.mapError(
          (error) =>
            new CollectorError({
              message: "Failed to read file",
              cause: error,
            }),
        ),
      );

    const plugin = {
      name: "alchemy:build-output",
      sharedDuringBuild: true,
      configResolved(config) {
        distDirectory ??= NodePath.resolve(config.root, config.build.outDir);
      },
      writeBundle(_, bundle) {
        const environment = this.environment.name;
        if (skipEnvironments.has(environment)) {
          return;
        }
        // Vite module ids are POSIX-separated even on Windows, so normalize
        // the root the same way before the prefix comparison.
        const root = NodePath.resolve(this.environment.config.root).replaceAll(
          "\\",
          "/",
        );
        for (const id of this.getModuleIds()) {
          const posixId = id.replaceAll("\\", "/");
          if (
            !NodePath.isAbsolute(id) ||
            posixId.includes("node_modules") ||
            posixId.startsWith(root)
          ) {
            continue;
          }
          externalDirectories.add(NodePath.dirname(id));
        }
        const outDir = NodePath.resolve(
          root,
          this.environment.config.build.outDir,
        );
        if (environment === clientEnvironment) {
          clientDirectory = outDir;
          return;
        }
        serverOutputs.set(environment, { root, outDir });
        const prefix = NodePath.relative(distDirectory ?? root, outDir);
        for (const file of Object.values(bundle)) {
          const name = toModuleName(prefix, file.fileName);
          const content = file.type === "chunk" ? file.code : file.source;
          serverModules.set(name, toOutputFile(name, content));
          if (file.type === "chunk") {
            if (environment === entryEnvironment && file.isEntry) {
              // Deterministic entry selection: an explicitly selected chunk
              // wins over the wrapped worker-entry facade, which wins over any
              // other entry chunk. Some frameworks emit multiple entry chunks
              // in the entry environment (e.g. Waku's `index` + `build`), and
              // only the configured main is guaranteed to be a worker module.
              const chunk: ServerEntryChunk = {
                fileName: file.fileName,
                name,
                facadeModuleId: file.facadeModuleId,
              };
              const priority = selectEntry?.(chunk)
                ? 3
                : file.facadeModuleId?.startsWith(WORKER_ENTRY_PREFIX)
                  ? 2
                  : 1;
              if (priority >= serverEntryPriority) {
                serverEntry = name;
                serverEntryPriority = priority;
              }
            }
            for (const id of file.imports) {
              if (!isRscManifestId(id)) continue;
              const fileName = RSC_MANIFEST[id];
              const manifestName = toModuleName(prefix, fileName);
              if (serverModules.has(manifestName)) continue;
              serverModules.set(
                manifestName,
                readFile(NodePath.resolve(outDir, fileName), manifestName),
              );
            }
          }
        }
        if (environment === entryEnvironment && !serverEntry) {
          throw new Error("Server entry not found");
        }
      },
    } satisfies Vite.Plugin;

    const collectInMemory = (): Effect.Effect<
      Array<OutputFile> | undefined,
      CollectorError
    > => {
      if (!serverEntry && !serverModules.size) return Effect.undefined;
      return Effect.all(Array.from(serverModules.values()), {
        concurrency: "unbounded",
      }).pipe(Effect.map((modules) => sortServerModules(modules, serverEntry)));
    };

    const collectFromDisk = (
      options?: CollectOptions,
    ): Effect.Effect<Array<OutputFile> | undefined, CollectorError> =>
      Effect.gen(function* () {
        if (!serverOutputs.size) return yield* collectInMemory();
        const modules = new Map<string, OutputFile>();
        for (const { root, outDir } of serverOutputs.values()) {
          const prefix = NodePath.relative(distDirectory ?? root, outDir);
          const files = yield* readServerModulesFromDisk({
            directory: outDir,
            prefix,
            isTextFile: options?.isTextFile,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          for (const file of files) {
            modules.set(file.name, file);
          }
        }
        if (serverEntry && !modules.has(serverEntry)) {
          return yield* Effect.fail(
            new CollectorError({
              message: `Server entry "${serverEntry}" not found on disk`,
            }),
          );
        }
        return sortServerModules(Array.from(modules.values()), serverEntry);
      });

    const collect = (
      options?: CollectOptions,
    ): Effect.Effect<BuildOutput, CollectorError> =>
      Effect.all(
        [
          options?.fromDisk ? collectFromDisk(options) : collectInMemory(),
          collectExternalWorkspaces(externalDirectories).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(
          ([modules, externalWorkspaces]) =>
            ({
              distDirectory,
              clientDirectory,
              serverModules: modules,
              externalWorkspaces,
            }) satisfies BuildOutput,
        ),
      );

    return {
      plugin,
      collect,
    };
  });

export interface ReadServerModulesOptions {
  /** The directory to read (a server environment's outDir). */
  readonly directory: string;
  /**
   * Prefix prepended to every module name (the outDir's path relative to the
   * build's dist directory, e.g. `server`).
   * @default ""
   */
  readonly prefix?: string | undefined;
  /**
   * Decides which files are read as text (everything else is read as binary).
   * @default matches {@link DEFAULT_TEXT_FILE_REGEX}
   */
  readonly isTextFile?: ((fileName: string) => boolean) | undefined;
}

/**
 * Read a server output directory from disk into {@link OutputFile}s (unsorted;
 * use {@link sortServerModules} to put the entry first). Used by frameworks
 * whose final server bundle lives on disk rather than in Vite's in-memory
 * `writeBundle` (SvelteKit's rolldown pass, Next.js's `.open-next` output),
 * and by the collector's `fromDisk` mode.
 */
export const readServerModulesFromDisk = (
  options: ReadServerModulesOptions,
): Effect.Effect<Array<OutputFile>, CollectorError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const isTextFile =
      options.isTextFile ??
      ((name: string) => DEFAULT_TEXT_FILE_REGEX.test(name));
    const readError = (error: unknown) =>
      new CollectorError({
        message: "Failed to read server modules from disk",
        cause: error,
      });
    const entries = yield* fs
      .readDirectory(options.directory, { recursive: true })
      .pipe(Effect.mapError(readError));
    const files = yield* Effect.forEach(
      entries.sort(),
      (entry): Effect.Effect<OutputFile | undefined, CollectorError> =>
        Effect.gen(function* () {
          const file = NodePath.join(options.directory, entry);
          const info = yield* fs.stat(file).pipe(Effect.mapError(readError));
          if (info.type !== "File") return undefined;
          const name = toModuleName(options.prefix ?? "", entry);
          const content: string | Uint8Array = isTextFile(file)
            ? yield* fs.readFileString(file).pipe(Effect.mapError(readError))
            : yield* fs.readFile(file).pipe(Effect.mapError(readError));
          return yield* toOutputFile(name, content);
        }),
      { concurrency: 16 },
    );
    return files.filter((file) => file !== undefined);
  });

/**
 * Resolve the workspace root (nearest directory containing a `package.json`)
 * of every directory, deduplicated. Directories with no enclosing workspace
 * are dropped.
 */
export const collectExternalWorkspaces = (
  directories: Iterable<string>,
): Effect.Effect<Set<string>, CollectorError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const findUp = yield* cachedFunction(
      (
        dir: string,
        filenames: Array<string>,
      ): Effect.Effect<string | undefined, PlatformError> =>
        Effect.filter(
          filenames.map((filename) => NodePath.join(dir, filename)),
          fs.exists,
          { concurrency: "unbounded" },
        ).pipe(
          Effect.flatMap(([match]) => {
            if (match) {
              return Effect.succeed(match);
            }
            const parent = NodePath.dirname(dir);
            if (parent === dir) {
              return Effect.undefined;
            }
            return findUp(parent, filenames);
          }),
        ),
    );
    return yield* Effect.forEach(directories, (directory) =>
      findUp(directory, ["package.json"]),
    ).pipe(
      Effect.map(
        (paths) =>
          new Set(
            paths
              .filter((file) => file !== undefined)
              .map((file) => NodePath.dirname(file)),
          ),
      ),
      Effect.mapError(
        (error) =>
          new CollectorError({
            message: "Failed to collect external workspaces",
            cause: error,
          }),
      ),
    );
  });

const cachedFunction = <A extends ReadonlyArray<any>, B, E, R>(
  fn: (...args: A) => Effect.Effect<B, E, R>,
): Effect.Effect<(...args: A) => Effect.Effect<B, E, R>> =>
  Cache.make({
    lookup: (key: A) => fn(...key),
    capacity: Infinity,
    requireServicesAt: "lookup",
  }).pipe(
    Effect.map(
      (cache) =>
        (...args: A) =>
          Cache.get(cache, args),
    ),
  );

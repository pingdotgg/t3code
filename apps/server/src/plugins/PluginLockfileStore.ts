import {
  EMPTY_PLUGIN_LOCKFILE,
  PluginId,
  PluginLockfile,
  PluginState,
  type PluginLockfilePlugin,
} from "@t3tools/contracts/plugin";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { pluginAdvisoryLockPath, pluginLockfilePath } from "./PluginPaths.ts";

const STALE_LOCK_MS = 60_000;
const PluginLockfileJson = Schema.fromJsonString(PluginLockfile);
const decodePluginLockfileJson = Schema.decodeUnknownEffect(PluginLockfileJson);
const encodePluginLockfileJson = Schema.encodeEffect(PluginLockfileJson);

export class PluginLockfileReadError extends Schema.TaggedErrorClass<PluginLockfileReadError>()(
  "PluginLockfileReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read plugin lockfile at ${this.path}.`;
  }
}

export class PluginLockfileCorruptError extends Schema.TaggedErrorClass<PluginLockfileCorruptError>()(
  "PluginLockfileCorruptError",
  { path: Schema.String, detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin lockfile at ${this.path} is corrupt: ${this.detail}`;
  }
}

export class PluginLockfileWriteError extends Schema.TaggedErrorClass<PluginLockfileWriteError>()(
  "PluginLockfileWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write plugin lockfile at ${this.path}.`;
  }
}

export class PluginLockfileLockError extends Schema.TaggedErrorClass<PluginLockfileLockError>()(
  "PluginLockfileLockError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not acquire plugin lockfile advisory lock at ${this.path}.`;
  }
}

export class PluginLockfileTransitionError extends Schema.TaggedErrorClass<PluginLockfileTransitionError>()(
  "PluginLockfileTransitionError",
  {
    pluginId: PluginId,
    from: Schema.Array(PluginState),
    to: PluginState,
    actual: Schema.NullOr(PluginState),
  },
) {
  override get message(): string {
    return `Cannot transition plugin ${this.pluginId} from ${this.actual ?? "missing"} to ${this.to}.`;
  }
}

export type PluginLockfileStoreError =
  | PluginLockfileReadError
  | PluginLockfileCorruptError
  | PluginLockfileWriteError
  | PluginLockfileLockError
  | PluginLockfileTransitionError;

export interface PluginLockfileMutationContext {
  readonly lockfile: PluginLockfile;
  readonly current: PluginLockfilePlugin | undefined;
}

export class PluginLockfileStore extends Context.Service<
  PluginLockfileStore,
  {
    readonly lockfilePath: string;
    readonly advisoryLockPath: string;
    readonly readLockfile: Effect.Effect<
      PluginLockfile,
      PluginLockfileReadError | PluginLockfileCorruptError
    >;
    readonly updateSources: (
      fn: (
        sources: ReadonlyArray<PluginLockfile["sources"][number]>,
        lockfile: PluginLockfile,
      ) => Effect.Effect<
        ReadonlyArray<PluginLockfile["sources"][number]>,
        PluginLockfileStoreError
      >,
    ) => Effect.Effect<PluginLockfile, PluginLockfileStoreError>;
    readonly updatePlugin: (
      id: PluginId,
      fn: (
        context: PluginLockfileMutationContext,
      ) => Effect.Effect<PluginLockfilePlugin | undefined, PluginLockfileStoreError>,
    ) => Effect.Effect<PluginLockfile, PluginLockfileStoreError>;
    readonly removePlugin: (
      id: PluginId,
    ) => Effect.Effect<PluginLockfile, PluginLockfileStoreError>;
    readonly transition: (
      id: PluginId,
      from: ReadonlyArray<PluginState>,
      to: PluginState,
    ) => Effect.Effect<PluginLockfile, PluginLockfileStoreError>;
  }
>()("t3/plugins/PluginLockfileStore") {}

const isNotFound = (cause: { readonly reason?: { readonly _tag?: string } }) =>
  cause.reason?._tag === "NotFound";

const readLockfileFromPath = (lockfilePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(lockfilePath)
      .pipe(
        Effect.catch((cause) =>
          isNotFound(cause)
            ? Effect.succeed(null)
            : Effect.fail(new PluginLockfileReadError({ path: lockfilePath, cause })),
        ),
      );
    if (raw === null) return EMPTY_PLUGIN_LOCKFILE;
    return yield* decodePluginLockfileJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new PluginLockfileCorruptError({
            path: lockfilePath,
            detail: String(cause),
            cause,
          }),
      ),
    );
  });

const writeLockfileToPath = (input: {
  readonly pluginsDir: string;
  readonly lockfilePath: string;
  readonly lockfile: PluginLockfile;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const encoded = yield* encodePluginLockfileJson(input.lockfile);
      const bytes = new TextEncoder().encode(`${encoded}\n`);

      yield* fs.makeDirectory(input.pluginsDir, { recursive: true });
      const tempDir = yield* fs.makeTempDirectoryScoped({
        directory: input.pluginsDir,
        prefix: `${path.basename(input.lockfilePath)}.`,
      });
      const tempPath = path.join(tempDir, "contents.tmp");
      const file = yield* fs.open(tempPath, { flag: "w", mode: 0o600 });
      yield* file.writeAll(bytes);
      yield* file.sync;
      yield* fs.rename(tempPath, input.lockfilePath);
      yield* fs.open(input.pluginsDir, { flag: "r" }).pipe(
        Effect.flatMap((directory) => directory.sync),
        Effect.ignore,
      );
    }),
  ).pipe(
    Effect.mapError((cause) => new PluginLockfileWriteError({ path: input.lockfilePath, cause })),
  );

const acquireAdvisoryLock = (input: {
  readonly pluginsDir: string;
  readonly advisoryLockPath: string;
}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(input.pluginsDir, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
          ),
        );

      const openLock = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(input.advisoryLockPath, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(
            new TextEncoder().encode(`${process.pid}:${yield* Clock.currentTimeMillis}\n`),
          );
          yield* file.sync;
        }),
      );

      const opened = yield* openLock.pipe(Effect.result);
      if (Result.isSuccess(opened)) return input.advisoryLockPath;

      const stat = yield* fs
        .stat(input.advisoryLockPath)
        .pipe(
          Effect.mapError(
            (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
          ),
        );
      const mtime = Option.getOrUndefined(stat.mtime);
      const ageMs = mtime ? (yield* Clock.currentTimeMillis) - mtime.getTime() : 0;
      if (ageMs <= STALE_LOCK_MS) {
        return yield* new PluginLockfileLockError({
          path: input.advisoryLockPath,
          cause: opened.failure,
        });
      }

      yield* Effect.logWarning("Reclaiming stale plugin lockfile advisory lock", {
        path: input.advisoryLockPath,
        ageMs,
      });
      yield* fs
        .remove(input.advisoryLockPath, { force: true })
        .pipe(
          Effect.mapError(
            (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
          ),
        );
      yield* openLock.pipe(
        Effect.mapError(
          (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
        ),
      );
      return input.advisoryLockPath;
    }),
    (lockPath) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(lockPath, { force: true })),
        Effect.ignore,
      ),
  );

export const make = Effect.fn("PluginLockfileStore.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const semaphore = yield* Semaphore.make(1);
  const lockfilePath = pluginLockfilePath(config.pluginsDir, path.join);
  const advisoryLockPath = pluginAdvisoryLockPath(config.pluginsDir, path.join);
  const provideLocalServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const readLockfile = provideLocalServices(readLockfileFromPath(lockfilePath));

  const mutate = (
    update: (lockfile: PluginLockfile) => Effect.Effect<PluginLockfile, PluginLockfileStoreError>,
  ) =>
    provideLocalServices(
      semaphore.withPermits(1)(
        Effect.scoped(
          acquireAdvisoryLock({ pluginsDir: config.pluginsDir, advisoryLockPath }).pipe(
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const current = yield* readLockfile;
                const next = yield* update(current);
                yield* writeLockfileToPath({
                  pluginsDir: config.pluginsDir,
                  lockfilePath,
                  lockfile: next,
                });
                return next;
              }),
            ),
          ),
        ),
      ),
    );

  const updatePlugin: PluginLockfileStore["Service"]["updatePlugin"] = (id, fn) =>
    mutate((lockfile) =>
      Effect.gen(function* () {
        const current = lockfile.plugins[id];
        const nextPlugin = yield* fn({ lockfile, current });
        const plugins = { ...lockfile.plugins };
        if (nextPlugin === undefined) {
          delete plugins[id];
        } else {
          plugins[id] = nextPlugin;
        }
        return { ...lockfile, plugins };
      }),
    );

  const updateSources: PluginLockfileStore["Service"]["updateSources"] = (fn) =>
    mutate((lockfile) =>
      Effect.gen(function* () {
        const sources = yield* fn(lockfile.sources, lockfile);
        return { ...lockfile, sources: Array.from(sources) };
      }),
    );

  const removePlugin: PluginLockfileStore["Service"]["removePlugin"] = (id) =>
    updatePlugin(id, () => Effect.succeed(undefined as PluginLockfilePlugin | undefined));

  const transition: PluginLockfileStore["Service"]["transition"] = (id, from, to) =>
    updatePlugin(id, ({ current }) => {
      if (!current || !from.includes(current.state)) {
        return Effect.fail(
          new PluginLockfileTransitionError({
            pluginId: id,
            from: Array.from(from),
            to,
            actual: current?.state ?? null,
          }),
        );
      }
      return Effect.succeed({ ...current, state: to });
    });

  return PluginLockfileStore.of({
    lockfilePath,
    advisoryLockPath,
    readLockfile,
    updateSources,
    updatePlugin,
    removePlugin,
    transition,
  });
});

export const layer = Layer.effect(PluginLockfileStore, make());

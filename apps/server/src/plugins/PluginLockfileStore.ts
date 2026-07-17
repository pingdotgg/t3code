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
import * as NodeCrypto from "node:crypto";

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
  { path: Schema.String, cause: Schema.Defect() },
) {
  // Derive the message from the stable `path` only — never from the stringified
  // decode error — so the wrapper cannot leak corrupt lockfile contents. The
  // underlying failure is preserved on `cause` (Schema.Defect) for diagnostics.
  override get message(): string {
    return `Plugin lockfile at ${this.path} is corrupt.`;
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
    readonly updatePlugin: <E = never>(
      id: PluginId,
      fn: (
        context: PluginLockfileMutationContext,
      ) => Effect.Effect<PluginLockfilePlugin | undefined, PluginLockfileStoreError | E>,
    ) => Effect.Effect<PluginLockfile, PluginLockfileStoreError | E>;
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
      // Owner token written into the lock file on acquire and re-checked in the
      // finalizer: a random nonce makes it unique to THIS holder even across
      // stale-lock reclamation, so a slow/paused prior holder's finalizer cannot
      // delete a different process's now-valid lock and break single-writer.
      const ownerToken = `${process.pid}:${NodeCrypto.randomUUID()}`;
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
          // `wx` created the file; only the write/sync can now fail. If it does
          // (ENOSPC/IO) or is interrupted mid-write, remove the file we just
          // created — acquire has not succeeded, so acquireRelease's release is
          // not registered, and an orphaned lock would block all lockfile
          // mutations until STALE_LOCK_MS elapses. Token-guard the removal the same
          // way the release finalizer does: if this fiber stalled past
          // STALE_LOCK_MS and another process reclaimed the lock (rewriting it with
          // ITS token) before our write failed, an unconditional remove would
          // delete that other process's valid lock and break single-writer.
          yield* file.writeAll(new TextEncoder().encode(`${ownerToken}\n`)).pipe(
            Effect.andThen(file.sync),
            Effect.onError(() =>
              // Atomic claim-then-inspect: a read-then-remove race can delete
              // another process's lock after it reclaims the stale file (we
              // read our empty/token, they rewrite, we remove). Rename the
              // path to a unique claim file first; only remove if the claimed
              // contents are still ours (or empty). If the contents belong to
              // another holder, put the lock back.
              Effect.gen(function* () {
                const claimPath = `${input.advisoryLockPath}.claim-${ownerToken.replaceAll(":", "-")}`;
                yield* fs.rename(input.advisoryLockPath, claimPath);
                const content = yield* fs.readFileString(claimPath);
                const trimmed = content.trim();
                if (trimmed === "" || trimmed === ownerToken) {
                  yield* fs.remove(claimPath, { force: true });
                } else {
                  yield* fs.rename(claimPath, input.advisoryLockPath);
                }
              }).pipe(Effect.ignore),
            ),
          );
        }),
      );

      const opened = yield* openLock.pipe(Effect.result);
      if (Result.isSuccess(opened)) return { path: input.advisoryLockPath, token: ownerToken };

      const statOption = yield* fs.stat(input.advisoryLockPath).pipe(
        Effect.map((info) => Option.some(info)),
        // The lock was released between openLock failing and this stat — it is
        // free now, so retry acquisition instead of reporting spurious
        // contention as a lock error.
        Effect.catchIf(isNotFound, () => Effect.succeed(Option.none())),
        Effect.mapError(
          (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
        ),
      );
      if (Option.isNone(statOption)) {
        yield* openLock.pipe(
          Effect.mapError(
            (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
          ),
        );
        return { path: input.advisoryLockPath, token: ownerToken };
      }
      const stat = statOption.value;
      const mtime = Option.getOrUndefined(stat.mtime);
      const ageMs = mtime ? (yield* Clock.currentTimeMillis) - mtime.getTime() : 0;
      if (ageMs <= STALE_LOCK_MS) {
        return yield* new PluginLockfileLockError({
          path: input.advisoryLockPath,
          cause: opened.failure,
        });
      }

      // Re-check the lock's mtime immediately before removing it. Between the
      // first stat above and now, another process may have released this stale
      // lock and a third re-acquired it. Removing a lock that was refreshed in
      // the meantime would delete a fresh, valid lock and break the
      // single-writer guarantee. Only reclaim when the file is unchanged (same
      // stale mtime) or already gone; if it was refreshed, treat it as live
      // contention and fail rather than clobber it.
      const stillStale = yield* fs.stat(input.advisoryLockPath).pipe(
        Effect.map((current) => {
          const currentMtime = Option.getOrUndefined(current.mtime);
          return (
            currentMtime !== undefined &&
            mtime !== undefined &&
            currentMtime.getTime() === mtime.getTime()
          );
        }),
        // Already released between our checks — safe to (re)acquire.
        Effect.catchIf(isNotFound, () => Effect.succeed(true)),
        Effect.mapError(
          (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
        ),
      );
      if (!stillStale) {
        return yield* new PluginLockfileLockError({
          path: input.advisoryLockPath,
          cause: opened.failure,
        });
      }

      yield* Effect.logWarning("Reclaiming stale plugin lockfile advisory lock", {
        path: input.advisoryLockPath,
        ageMs,
      });
      // Claim the stale lock ATOMICALLY by renaming it to a token-unique path
      // before removing it. `remove` is not exclusive: two reclaimers that both
      // pass the stillStale mtime check would both `remove` and then one could
      // clobber the other's freshly-created lock (P2's remove landing between P1's
      // create and P1's use), leaving BOTH believing they hold the lock and losing
      // a lockfile mutation. Only ONE racer can rename a given source path — the
      // loser sees the source already gone (NotFound) and reports contention.
      const reclaimPath = `${input.advisoryLockPath}.reclaim-${ownerToken.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
      const claimed = yield* fs.rename(input.advisoryLockPath, reclaimPath).pipe(
        Effect.as(true),
        // Another reclaimer won (renamed/removed it first) — treat as live
        // contention rather than clobbering their now-valid lock.
        Effect.catchIf(isNotFound, () => Effect.succeed(false)),
        Effect.mapError(
          (cause) => new PluginLockfileLockError({ path: input.advisoryLockPath, cause }),
        ),
      );
      if (!claimed) {
        return yield* new PluginLockfileLockError({
          path: input.advisoryLockPath,
          cause: opened.failure,
        });
      }
      yield* fs
        .remove(reclaimPath, { force: true })
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
      return { path: input.advisoryLockPath, token: ownerToken };
    }),
    ({ path: lockPath, token }) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          // Only remove the lock if it still carries OUR token. If a stale-lock
          // reclaimer overwrote it with its own token, leave that valid lock in
          // place instead of clobbering it.
          fs
            .readFileString(lockPath)
            .pipe(
              Effect.flatMap((content) =>
                content.trim() === token ? fs.remove(lockPath, { force: true }) : Effect.void,
              ),
            ),
        ),
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

  const mutate = <E = never>(
    update: (
      lockfile: PluginLockfile,
    ) => Effect.Effect<PluginLockfile, PluginLockfileStoreError | E>,
  ) =>
    provideLocalServices(
      semaphore.withPermits(1)(
        Effect.scoped(
          acquireAdvisoryLock({ pluginsDir: config.pluginsDir, advisoryLockPath }).pipe(
            Effect.flatMap((lock) =>
              Effect.gen(function* () {
                const current = yield* readLockfile;
                const next = yield* update(current);
                // Re-verify we still own the advisory lock immediately before
                // writing. If this fiber/process was paused past STALE_LOCK_MS
                // (GC/CPU starvation) another process may have reclaimed the lock
                // and become the writer; writing now would race it and lose an
                // update. The owner token is unique per acquisition, so a mismatch
                // means we were reclaimed.
                const owner = yield* fs.readFileString(lock.path).pipe(
                  Effect.map((content) => content.trim()),
                  Effect.orElseSucceed(() => ""),
                );
                if (owner !== lock.token) {
                  return yield* new PluginLockfileLockError({
                    path: lock.path,
                    cause: new Error(
                      "advisory lock ownership lost before write (reclaimed by another writer)",
                    ),
                  });
                }
                yield* writeLockfileToPath({
                  pluginsDir: config.pluginsDir,
                  lockfilePath,
                  lockfile: next,
                });
                // Post-write ownership read-back. The pre-write check narrows the
                // reclaim window but cannot close it: a reclaimer can still
                // interleave between that check and writeLockfileToPath's rename
                // after a >STALE_LOCK_MS holder stall. The write itself is atomic
                // (temp+rename, no corruption), but silently winning that race is
                // last-writer-wins — our write would clobber the reclaimer's update
                // with no signal. Re-read the lock; if it is no longer ours, fail
                // so the caller's retry re-reads and re-applies over the other
                // writer's committed state instead of losing it. Cheap: one read,
                // orElseSucceed("") like the pre-check.
                const ownerAfter = yield* fs.readFileString(lock.path).pipe(
                  Effect.map((content) => content.trim()),
                  Effect.orElseSucceed(() => ""),
                );
                if (ownerAfter !== lock.token) {
                  return yield* new PluginLockfileLockError({
                    path: lock.path,
                    cause: new Error("lock ownership lost during write"),
                  });
                }
                return next;
              }),
            ),
          ),
        ),
      ),
    );

  const updatePlugin = <E = never>(
    id: PluginId,
    fn: (
      context: PluginLockfileMutationContext,
    ) => Effect.Effect<PluginLockfilePlugin | undefined, PluginLockfileStoreError | E>,
  ): Effect.Effect<PluginLockfile, PluginLockfileStoreError | E> =>
    mutate<E>((lockfile) =>
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

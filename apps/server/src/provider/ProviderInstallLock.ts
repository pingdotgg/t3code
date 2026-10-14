import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/** A lock file this old is stale even if a process with its pid is alive (pid reuse). */
const MAX_LOCK_AGE = Duration.hours(1);
/** A reclaim sentinel this old was left by a process that died mid-reclaim. */
const MAX_SENTINEL_AGE = Duration.seconds(10);
const IDLE_POLL_INTERVAL = Duration.seconds(1);

export class ProviderInstallLockError extends Schema.TaggedError<ProviderInstallLockError>()(
  "ProviderInstallLockError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not use the provider install lock directory.";
  }
}

/**
 * A lock on running a provider installer, shared by every T3 server on this
 * host. Two servers must never run `npm i -g` on the same prefix at once, and
 * a CLI must not be replaced while another server is launching it.
 */
export class ProviderInstallLock extends Context.Service<
  ProviderInstallLock,
  {
    /**
     * Runs `run` while holding the lock for `lockKey`, or returns `None` without
     * running when another process holds it. `run` calls `recordChildPid` with the
     * installer's pid: a detached installer outlives this server, and the lock
     * stays held until it exits.
     */
    readonly tryRun: <A, E, R>(
      lockKey: string,
      run: (recordChildPid: (pid: number) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ProviderInstallLockError, R>;
    /** Completes once no installer holds any lock, or when the lock directory cannot be read. */
    readonly untilIdle: Effect.Effect<void>;
    /** Whether any lock is held right now. A failed read is an error, not "free". */
    readonly anyHeld: Effect.Effect<boolean, ProviderInstallLockError>;
  }
>()("t3/provider/ProviderInstallLock") {}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const cacheHome = environment.XDG_CACHE_HOME || path.join(homeDirectory, ".cache");
  const directory = path.join(cacheHome, "t3", "provider-install");

  const toLockError = (cause: unknown) => new ProviderInstallLockError({ cause });
  const ignoreNotFound =
    <B>(fallback: B) =>
    <A>(effect: Effect.Effect<A, PlatformError>): Effect.Effect<A | B, PlatformError> =>
      effect.pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(fallback) : Effect.fail(error),
        }),
      );

  /** Held while a recorded process is alive; a file mid-write counts as held until it ages out. */
  const isHeld = Effect.fn("ProviderInstallLock.isHeld")(function* (file: string) {
    const info = yield* fileSystem.stat(file);
    const modifiedAt = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    });
    if ((yield* Clock.currentTimeMillis) - modifiedAt >= Duration.toMillis(MAX_LOCK_AGE)) {
      return false;
    }
    // The file holds one pid: this server's, then its installer's once spawned.
    const pid = Number.parseInt(yield* fileSystem.readFileString(file), 10);
    return Number.isNaN(pid) || isPidAlive(pid);
  });

  const writePid = (file: string, pid: number, flag: "w" | "wx") =>
    fileSystem.writeFileString(file, String(pid), { flag });

  /** Creates `file` exclusively; false when it already exists. */
  const createExclusively = (file: string) =>
    writePid(file, process.pid, "wx").pipe(
      Effect.as(true),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
      }),
    );

  /** Takes the short-lived sentinel that serializes reclaimers; one left by a crashed process is removed. */
  const claimSentinel = Effect.fn("ProviderInstallLock.claimSentinel")(function* (
    sentinel: string,
  ) {
    if (yield* createExclusively(sentinel)) return true;
    const info = yield* fileSystem.stat(sentinel).pipe(ignoreNotFound(undefined));
    if (info !== undefined) {
      const modifiedAt = Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      if ((yield* Clock.currentTimeMillis) - modifiedAt < Duration.toMillis(MAX_SENTINEL_AGE)) {
        return false;
      }
      yield* fileSystem.remove(sentinel, { force: true });
    }
    return yield* createExclusively(sentinel);
  });

  /**
   * Creates the lock file exclusively; false when it exists and is held. A stale one is
   * reclaimed under a sentinel, so a second reclaimer cannot delete the first one's fresh lock.
   */
  const acquire = Effect.fn("ProviderInstallLock.acquire")(function* (file: string) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    if (yield* createExclusively(file)) return true;
    if (yield* isHeld(file).pipe(ignoreNotFound(false))) return false;
    const sentinel = `${file}.reclaim`;
    if (!(yield* claimSentinel(sentinel))) return false;
    return yield* Effect.gen(function* () {
      if (yield* isHeld(file).pipe(ignoreNotFound(false))) return false;
      yield* fileSystem.remove(file, { force: true });
      return yield* createExclusively(file);
    }).pipe(Effect.ensuring(fileSystem.remove(sentinel, { force: true }).pipe(Effect.ignore)));
  });

  const tryRun: ProviderInstallLock["Service"]["tryRun"] = (lockKey, run) => {
    const file = path.join(directory, `${encodeURIComponent(lockKey)}.lock`);
    return Effect.acquireUseRelease(
      acquire(file).pipe(
        Effect.mapError(toLockError),
        // The ref holds the installer pid once `run` records it.
        Effect.flatMap((acquired) =>
          acquired ? Ref.make<number | undefined>(undefined) : Effect.succeed(undefined),
        ),
      ),
      (installerPid) =>
        installerPid === undefined
          ? Effect.succeedNone
          : run((pid) =>
              Ref.set(installerPid, pid).pipe(
                Effect.andThen(writePid(file, pid, "w")),
                Effect.catch((cause) =>
                  Effect.logWarning("Could not record the provider installer in its lock", {
                    cause,
                  }),
                ),
              ),
            ).pipe(Effect.map(Option.some)),
      (installerPid) =>
        installerPid === undefined
          ? Effect.void
          : Ref.get(installerPid).pipe(
              // A detached installer outlives this server; its pid keeps the lock held.
              Effect.flatMap((pid) =>
                pid !== undefined && isPidAlive(pid)
                  ? Effect.void
                  : fileSystem.remove(file, { force: true }),
              ),
              Effect.ignore,
            ),
    );
  };

  const anyHeld = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(directory).pipe(ignoreNotFound([]));
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      if (yield* isHeld(path.join(directory, name)).pipe(ignoreNotFound(false))) return true;
    }
    return false;
  }).pipe(Effect.mapError(toLockError));

  const untilIdle: Effect.Effect<void> = Effect.suspend(() =>
    anyHeld.pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((held) =>
        held ? Effect.sleep(IDLE_POLL_INTERVAL).pipe(Effect.andThen(untilIdle)) : Effect.void,
      ),
    ),
  );

  return ProviderInstallLock.of({ tryRun, untilIdle, anyHeld });
});

export const layer = Layer.effect(ProviderInstallLock, make);

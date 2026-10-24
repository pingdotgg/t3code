import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

// The wrapper's go deadline + install backstop stay below this cap; the
// generation handshake fences owners paused before creating their wrapper.
const MAX_LOCK_AGE = Duration.hours(1);
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
     * stays held until both `run` completes and the installer exits.
     */
    readonly tryRun: <A, E, R>(
      lockKey: string,
      run: (
        recordChildPid: (pid: number) => Effect.Effect<void, ProviderInstallLockError>,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ProviderInstallLockError, R>;
    /** Completes once no installer holds any lock, or when the lock directory cannot be read. */
    readonly untilIdle: Effect.Effect<void>;
    /** Whether any lock is held right now. A failed read is an error, not "free". */
    readonly anyHeld: Effect.Effect<boolean, ProviderInstallLockError>;
  }
>()("t3/provider/ProviderInstallLock") {}

const isProviderInstallLockError = Schema.is(ProviderInstallLockError);

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseGeneration(name: string) {
  const match = /^(.+\.lock)\.([1-9]\d*)$/.exec(name);
  if (!match) return undefined;
  const generation = Number(match[2]);
  return Number.isSafeInteger(generation) ? { key: match[1]!, generation, name } : undefined;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const cacheHome = environment.XDG_CACHE_HOME || path.join(homeDirectory, ".cache");
  const directory = path.join(cacheHome, "t3", "provider-install");

  const toLockError = (cause: unknown) =>
    isProviderInstallLockError(cause) ? cause : new ProviderInstallLockError({ cause });
  const ignoreNotFound =
    <B>(fallback: B) =>
    <A>(effect: Effect.Effect<A, PlatformError>): Effect.Effect<A | B, PlatformError> =>
      effect.pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(fallback) : Effect.fail(error),
        }),
      );

  const readRecord = Effect.fn("ProviderInstallLock.readRecord")(function* (file: string) {
    const info = yield* fileSystem.stat(file);
    const modifiedAt = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    });
    const expired =
      (yield* Clock.currentTimeMillis) - modifiedAt >= Duration.toMillis(MAX_LOCK_AGE);
    // The first line holds pids; the second identifies the owning run, including within one server.
    const contents = yield* fileSystem.readFileString(file);
    const [pids = ""] = contents.split("\n");
    const recorded = pids.split(" ").map(Number);
    const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
    const live = recorded.some((pid) => valid(pid) && isPidAlive(pid));
    return {
      contents,
      modifiedAt,
      held: !expired && pids !== "released" && (live || recorded.some((pid) => !valid(pid))),
      expiredLive: expired && live,
    };
  });
  const isHeld = (file: string) => readRecord(file).pipe(Effect.map((record) => record.held));

  /** Publishes a complete record exclusively; a paused writer must never look abandoned. */
  const createExclusively = (file: string, contents: string, owner: string) => {
    const temporary = `${file}.${owner}.tmp`;
    return Effect.gen(function* () {
      const handle = yield* fileSystem.open(temporary, { flag: "wx" });
      yield* handle.writeAll(new TextEncoder().encode(contents));
    }).pipe(
      Effect.scoped,
      // Unlike rename, link cannot overwrite another contender's generation.
      Effect.andThen(fileSystem.link(temporary, file)),
      Effect.as(true),
      Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
      }),
    );
  };

  const generations = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(directory).pipe(ignoreNotFound([]));
    return names.flatMap((name) => {
      const parsed = parseGeneration(name);
      return parsed ? [parsed] : [];
    });
  });

  /**
   * Only exclusive creation elects an owner. The highest generation is retained
   * even after release, so a delayed reclaimer cannot reuse its number.
   */
  const acquire = Effect.fn("ProviderInstallLock.acquire")(function* (
    key: string,
    contents: string,
    owner: string,
  ) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    // Older servers wrote an unnumbered lock with the same age cap.
    if (yield* isHeld(path.join(directory, key)).pipe(ignoreNotFound(false))) return undefined;
    const previous = (yield* generations).filter((entry) => entry.key === key);
    const highest = previous.reduce((max, entry) => Math.max(max, entry.generation), 0);
    const previousFile = highest > 0 ? path.join(directory, `${key}.${highest}`) : undefined;
    const previousRecord =
      previousFile === undefined
        ? undefined
        : yield* readRecord(previousFile).pipe(ignoreNotFound(undefined));
    if (previousRecord?.held) return undefined;
    const next = highest + 1;
    const file = path.join(directory, `${key}.${next}`);
    if (!(yield* createExclusively(file, contents, owner))) return undefined;
    // Our directory snapshot may predate a successor that already pruned this
    // number. A recreated lower generation must never run an installer.
    if ((yield* generations).some((entry) => entry.key === key && entry.generation > next)) {
      yield* fileSystem.remove(file, { force: true });
      return undefined;
    }
    if (
      previousFile !== undefined &&
      (previousRecord === undefined || previousRecord.expiredLive)
    ) {
      // On one host these fs operations are linearizable: owner writes N then
      // reads the directory; successor links N+1 then reads N. At least one
      // sees the other, so both can back off but cannot both start installers.
      const current = yield* readRecord(previousFile).pipe(ignoreNotFound(undefined));
      if (
        current !== undefined &&
        (previousRecord === undefined ||
          current.contents !== previousRecord.contents ||
          current.modifiedAt !== previousRecord.modifiedAt)
      ) {
        // Restore N as highest; a released N+1 would hide its resumed owner.
        yield* fileSystem.remove(file, { force: true });
        return undefined;
      }
    }
    // A rejected successor can disappear after another contender snapshots it.
    // That contender must not skip the resumed owner below the missing generation.
    for (const entry of previous) {
      if (
        entry.generation < highest &&
        (yield* isHeld(path.join(directory, entry.name)).pipe(ignoreNotFound(false)))
      ) {
        yield* fileSystem.remove(file, { force: true });
        return undefined;
      }
    }
    yield* Effect.forEach(
      previous,
      (entry) =>
        fileSystem.remove(path.join(directory, entry.name), { force: true }).pipe(Effect.ignore),
      { discard: true },
    );
    return file;
  });

  const tryRun = Effect.fn("ProviderInstallLock.tryRun")(function* <A, E, R>(
    lockKey: string,
    run: (
      recordChildPid: (pid: number) => Effect.Effect<void, ProviderInstallLockError>,
    ) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<Option.Option<A>, E | ProviderInstallLockError, R> {
    const key = `${encodeURIComponent(lockKey)}.lock`;
    const owner = yield* crypto.randomUUIDv4().pipe(Effect.mapError(toLockError));
    const contents = `${process.pid}\n${owner}`;
    // Written aside and renamed over the lock, so a failed write (disk full)
    // leaves the previous complete record instead of an empty, held file.
    const replace = (file: string, next: string) => {
      const temporary = `${file}.${owner}.tmp`;
      return fileSystem.writeFileString(temporary, next).pipe(
        Effect.andThen(fileSystem.rename(temporary, file)),
        Effect.onError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
    };
    return yield* Effect.acquireUseRelease(
      acquire(key, contents, owner).pipe(
        Effect.mapError(toLockError),
        Effect.flatMap((acquired) =>
          acquired !== undefined
            ? Ref.make<{ file: string; pid: number | undefined; contents: string }>({
                file: acquired,
                pid: undefined,
                contents,
              })
            : Effect.succeed(undefined),
        ),
      ),
      (ownerState) =>
        ownerState === undefined
          ? Effect.succeedNone
          : run((pid) =>
              Effect.gen(function* () {
                const state = yield* Ref.get(ownerState);
                if ((yield* fileSystem.readFileString(state.file)) !== state.contents) {
                  return yield* toLockError(new Error("Provider install lock ownership changed"));
                }
                const next = `${process.pid} ${pid}\n${owner}`;
                yield* replace(state.file, next);
                yield* Ref.set(ownerState, { ...state, pid, contents: next });
                const generation = parseGeneration(path.basename(state.file))!;
                if (
                  (yield* generations).some(
                    (entry) => entry.key === key && entry.generation > generation.generation,
                  )
                ) {
                  return yield* toLockError(new Error("Provider install lock ownership expired"));
                }
              }).pipe(Effect.mapError(toLockError), Effect.uninterruptible),
            ).pipe(Effect.map(Option.some)),
      (ownerState) =>
        ownerState === undefined
          ? Effect.void
          : Ref.get(ownerState).pipe(
              Effect.flatMap((state) =>
                Effect.gen(function* () {
                  if ((yield* fileSystem.readFileString(state.file)) !== state.contents) return;
                  // Once `run` ends, only a surviving detached installer keeps the lock held.
                  yield* replace(
                    state.file,
                    `${state.pid !== undefined && isPidAlive(state.pid) ? state.pid : "released"}\n${owner}`,
                  );
                }),
              ),
              Effect.ignore,
            ),
    );
  });

  const anyHeld = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(directory).pipe(ignoreNotFound([]));
    // A provisional successor must not hide a resumed older owner from turn starts.
    for (const name of names) {
      if (name.endsWith(".lock") || parseGeneration(name) !== undefined) {
        if (yield* isHeld(path.join(directory, name)).pipe(ignoreNotFound(false))) return true;
      }
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

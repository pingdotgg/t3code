/**
 * One server per data directory.
 *
 * Two T3 Code servers pointed at the same `--base-dir` both open `state.sqlite`
 * and both write `settings.json`, and they overwrite each other. The observed
 * incident: a desktop app auto-updated to a newer server while the old one was
 * still running, the new process found its port taken, silently bound a random
 * one, and ran blind against shared state. The visible symptom was a settings
 * toggle that would not stick — hours away from the actual cause.
 *
 * Nothing about that is detectable after the fact, so the fix is to refuse at
 * startup. A second server against a held directory exits with one clear
 * message instead of corrupting state.
 *
 * ## Why a pid file rather than `flock`
 *
 * An advisory `flock` is the better primitive: the kernel drops it when the
 * holder dies, so a crashed server leaves nothing stale to clean up. Node has no
 * binding for it, and adding a native dependency to the server for one lock is a
 * worse trade than handling staleness here.
 *
 * So the lock is an atomically created file holding the owner's identity, and
 * liveness is checked with signal 0. The tradeoff is honest: if a server is
 * killed and its pid is later reused by an unrelated process, this refuses to
 * start until the file is removed. That is the safe direction to fail, and the
 * message names the file so recovery is one `rm`.
 *
 * ## Upgrading from a pre-lock version
 *
 * A pre-lock server writes no `server.lock`, so the file alone cannot see one.
 * It does persist `server-runtime.json` with its live pid though, so before
 * claiming the directory a live legacy runtime state is read as a held lock
 * and refused the same way. Otherwise the desktop auto-update incident this
 * exists to prevent still happens once on upgrade day — the new server starts
 * next to the old one against the same state.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

export const SERVER_LOCK_FILENAME = "server.lock";
export const SERVER_RUNTIME_STATE_FILENAME = "server-runtime.json";

export const ServerLockHolder = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startedAt: Schema.String,
  /** Absent until the server binds; the lock is taken before a port exists. */
  port: Schema.optional(Schema.Int),
});
export type ServerLockHolder = typeof ServerLockHolder.Type;

const ServerLockHolderFromJson = Schema.fromJsonString(ServerLockHolder);
const decodeHolder = Schema.decodeUnknownOption(ServerLockHolderFromJson);
const encodeHolder = Schema.encodeSync(ServerLockHolderFromJson);

export class ServerAlreadyRunningError extends Schema.TaggedErrorClass<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  {
    stateDir: Schema.String,
    lockPath: Schema.String,
    holderPid: Schema.Int,
    holderPort: Schema.optional(Schema.Int),
    holderStartedAt: Schema.String,
  },
) {
  override get message(): string {
    const where =
      this.holderPort === undefined
        ? `pid ${this.holderPid}`
        : `pid ${this.holderPid}, listening on port ${this.holderPort}`;
    return [
      "Another T3 Code server is already using this data directory.",
      "",
      `  data directory: ${this.stateDir}`,
      `  held by:        ${where}`,
      `  since:          ${this.holderStartedAt}`,
      "",
      "Two servers sharing one data directory overwrite each other's state.sqlite",
      "and settings.json. Stop the running server, or start this one with a",
      "different --base-dir.",
      "",
      `If that process is gone, remove ${this.lockPath} and start again.`,
    ].join("\n");
  }
}

export class ServerLockUnavailableError extends Schema.TaggedErrorClass<ServerLockUnavailableError>()(
  "ServerLockUnavailableError",
  {
    lockPath: Schema.String,
    attempts: Schema.Int,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not claim the server lock at ${this.lockPath} after ${this.attempts} attempts; another starting server kept reclaiming it.`;
  }
}

// How many reclaim-and-retry rounds against a confirmed-dead lock a starter
// tolerates before concluding something else keeps recreating it: nothing a
// real dead holder produces, everything a permission wall or a competing
// starter produces.
const MAX_RECLAIM_CYCLES = 3;

/**
 * Whether a pid is a live process.
 *
 * `EPERM` means it exists and belongs to someone else, which still counts — a
 * server started under a different user is exactly the case that must not be
 * trampled.
 */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readHolder = Effect.fn("serverSingleton.readHolder")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(lockPath)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
    );
  return Option.getOrUndefined(decodeHolder(raw));
});

// A dead holder's lock is not unlinked outright: between one starter reading a
// stale lock and another recreating it, an unconditional unlink would remove a
// live successor's claim. Reclamation instead refreshes the file's mtime
// `MAX_CLAIM_ATTEMPTS` times; only a file that stays the same dead content
// across every attempt is removed, so a live recreation always survives. The
// holder bumps the mtime once between attempts while it owns the lock, so no
// sequence of slower starters can reclaim out from under it either — and a
// dead holder still recycles its lock inside a second of startup time.
const MAX_CLAIM_ATTEMPTS = 3;
const RECLAIM_OBSERVATION_DELAY_MILLIS = 200;

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "AlreadyExists";

/**
 * A pre-lock server is live against this directory. Failure-phase marker rather
 * than an error: `serverRuntimeState.ts` already owns the file's decode-error
 * type, and the refusal shown to the user is the same `ServerAlreadyRunningError`
 * either way — `server.ts` converts this at the boundary where the config with
 * the path lives.
 */
export class LiveLegacyServerRuntime extends Data.TaggedError("LiveLegacyServerRuntime")<{
  readonly state: {
    readonly pid: number;
    readonly port: number;
    readonly startedAt: string;
  };
}> {}

/**
 * Claims the directory, or explains who holds it.
 *
 * A lock file whose owner is gone is reclaimed rather than treated as a
 * permanent block: a dead holder must not lock its own directory forever.
 * Reclaiming re-races the exclusive create, so two servers starting together
 * still produce exactly one winner.
 */
const claimLock = Effect.fn("serverSingleton.claimLock")(function* (input: {
  readonly stateDir: string;
  readonly lockPath: string;
  readonly legacyRuntimeStatePath: string;
  readonly startedAt: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const payload = encodeHolder({ version: 1, pid: process.pid, startedAt: input.startedAt });

  // A pre-lock server writes no lock, so the file alone is blind to one — but
  // it does persist its live pid in `server-runtime.json`. Refuse a live
  // legacy runtime exactly like a live lock holder, before the lock is ever
  // created; otherwise the upgrade that introduces this guard still starts
  // next to the very server it is meant to replace. A dead legacy pid is
  // ignored here: reclaim of its leftover lock is what removes the file.
  const legacyState = yield* readPersistedServerRuntimeState(input.legacyRuntimeStatePath);
  if (Option.isSome(legacyState) && processIsAlive(legacyState.value.pid)) {
    return yield* new LiveLegacyServerRuntime({ state: legacyState.value });
  }

  yield* fs.makeDirectory(path.dirname(input.lockPath), { recursive: true });

  // Counts how often this starter was forced to refresh a candidate stale lock
  // before believing it is really dead, and how often a confirmed-dead lock
  // bounced it back to another round (see the constants above).
  let reclaimRefreshes = 0;
  let reclaimCycles = 0;
  while (true) {
    // A scheduler yield between attempts, so a reclaim observation round lets
    // other starters (and the holder's heartbeat) run before this starter
    // concludes a lock never changed. Real time only — resolvable under
    // `TestClock`.
    yield* Effect.yieldNow;
    const created = yield* fs.writeFileString(input.lockPath, payload, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (created) return undefined;

    const holder = yield* readHolder(input.lockPath);
    if (holder !== undefined && processIsAlive(holder.pid)) {
      return new ServerAlreadyRunningError({
        stateDir: input.stateDir,
        lockPath: input.lockPath,
        holderPid: holder.pid,
        ...(holder.port === undefined ? {} : { holderPort: holder.port }),
        holderStartedAt: holder.startedAt,
      });
    }

    // The read found no live owner — either a decodeable dead holder, or
    // `undefined` because the file is missing (another starter mid-reclaim)
    // or undecodable (a crash tore a write in half). Never unlink after one
    // read: between this starter's read and its remove, a successor can win
    // the re-race and recreate its own live lock, and the unlink would delete
    // that. The candidate is mtime-refreshed and re-observed across
    // `MAX_CLAIM_ATTEMPTS` rounds, and only a file that stayed untouched
    // through every round is removed — a live successor's heartbeat always
    // refreshes inside one round, so the file a reclaimer finally removes is
    // provably still dead. The wait lands in the *next* loop head's
    // `Effect.yieldNow`, which keeps `claimLock` real-time-only so tests can
    // drive it without a fake clock.
    if (reclaimRefreshes >= MAX_CLAIM_ATTEMPTS) {
      // Removing frees the directory, and the create is retried on the next
      // pass: a cleanly restarted server after a crash claims its directory
      // here, not on a later manual retry. Bounded, so a lock another starter
      // keeps recreating (or a permissions wall keeps failing to remove for)
      // still surfaces as itself.
      yield* fs.remove(input.lockPath, { force: true });
      reclaimRefreshes = 0;
      reclaimCycles += 1;
      if (reclaimCycles >= MAX_RECLAIM_CYCLES) {
        return new ServerLockUnavailableError({
          lockPath: input.lockPath,
          attempts: reclaimCycles,
        });
      }
      continue;
    }

    reclaimRefreshes += 1;
    const now = yield* DateTime.now;
    // NotFound-tolerant: a shutdown mid-release can drop the file between our
    // read and our refresh, and the starter that released it is nobody's live
    // claim either way. The next pass's create or re-read settles it.
    yield* fs
      .utimes(input.lockPath, DateTime.toDateUtc(now), DateTime.toDateUtc(now))
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
        ),
      );
  }
});

/**
 * A live lock holder refreshes its claim's mtime once per reclaim-observation
 * round while it owns the lock. Any starter mid-reclaim then sees the file
 * change and backs off, so the holder's lock cannot be reclaimed from under it
 * no matter how many starters race. Stops with the scope that holds the lock.
 */
const holdServerLock = Effect.fn("serverSingleton.hold")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const tick = Effect.gen(function* () {
    const holder = yield* readHolder(lockPath);
    if (holder === undefined || holder.pid !== process.pid) return;
    const now = yield* DateTime.now;
    const date = DateTime.toDateUtc(now);
    yield* fs.utimes(lockPath, date, date);
  });
  const reschedule = Schedule.spaced(RECLAIM_OBSERVATION_DELAY_MILLIS);
  yield* Effect.forkScoped(
    tick.pipe(
      // Each tick is caught individually: `Effect.repeat` ends a failing
      // effect on the first failure, so recovery has to live inside the round.
      // The holder keeps refreshing for as long as it owns the lock, through
      // whatever transient filesystem errors come and go.
      Effect.catch(() => Effect.void),
      Effect.repeat({ schedule: reschedule, while: () => true }),
      Effect.catch(() => Effect.void),
    ),
  );
});

/**
 * Releases only a lock this process verifiably owns, so a successor is never
 * evicted. An undecodable file is left alone: it is either a live re-entrant
 * claim (the winning starter's just-created file, or another process's) or a
 * crash fragment, and crash fragments are what reclaim exists for.
 */
export const releaseServerLock = Effect.fn("serverSingleton.release")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const holder = yield* readHolder(lockPath);
  if (holder === undefined || holder.pid !== process.pid) return;
  yield* fs.remove(lockPath, { force: true }).pipe(Effect.ignore);
});

/**
 * Records the bound port on the lock we already hold.
 *
 * The rewrite goes through write-temp-then-rename so a reader never observes
 * an empty or partial file: with an in-place rewrite, a concurrent starter
 * could mistake the truncated file for a crashed owner and reclaim a live
 * lock — the exact concurrent-servers corruption the lock exists to prevent.
 *
 * Only for the error message a *later* server prints: knowing the holder's port
 * turns "something else is running" into an address the user can open. Failure
 * is ignored — the lock's job is done once it is held.
 */
export const recordServerLockPort = Effect.fn("serverSingleton.recordPort")(function* (
  lockPath: string,
  port: number,
) {
  const holder = yield* readHolder(lockPath);
  if (holder === undefined || holder.pid !== process.pid) return;
  yield* writeFileStringAtomically({
    filePath: lockPath,
    contents: encodeHolder({ ...holder, port }),
  }).pipe(Effect.ignore);
});

export const serverLockPath = Effect.fn("serverSingleton.lockPath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_LOCK_FILENAME);
});

export const legacyServerRuntimeStatePath = Effect.fn("serverSingleton.legacyStatePath")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME);
});

/**
 * Holds the data directory for the lifetime of the returned scope.
 *
 * Acquired before anything opens the database or binds a port, and released on
 * shutdown. A live pre-lock server reads as a held lock here too: callers see
 * one refusal type regardless of which generation holds the directory.
 */
export const acquireServerSingleton = Effect.fn("serverSingleton.acquire")(function* (
  stateDir: string,
) {
  const lockPath = yield* serverLockPath(stateDir);
  const legacyRuntimeStatePath = yield* legacyServerRuntimeStatePath(stateDir);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const failure = yield* claimLock({
        stateDir,
        lockPath,
        legacyRuntimeStatePath,
        startedAt,
      }).pipe(
        // The message names `server-runtime.json` (not `server.lock`) as the
        // file to remove if the process is gone — that is all a pre-lock
        // server ever wrote.
        Effect.catchTags({
          LiveLegacyServerRuntime: (legacy) =>
            Effect.fail(
              new ServerAlreadyRunningError({
                stateDir,
                lockPath: legacyRuntimeStatePath,
                holderPid: legacy.state.pid,
                holderPort: legacy.state.port,
                holderStartedAt: legacy.state.startedAt,
              }),
            ),
        }),
      );
      if (failure !== undefined) return yield* failure;
      yield* holdServerLock(lockPath);
      return lockPath;
    }),
    () => releaseServerLock(lockPath).pipe(Effect.ignore),
  );
});

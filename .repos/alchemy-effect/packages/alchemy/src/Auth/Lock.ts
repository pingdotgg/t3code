import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { rootDir } from "./Profile.ts";

const semaphores = new Map<string, Semaphore.Semaphore>();

// Keep STALE well above REFRESH — a saturated machine can starve the
// heartbeat fiber for seconds.
const STALE = Duration.seconds(30);
const REFRESH = Duration.seconds(10);
const RETRY_INTERVAL = Duration.millis(50);
const DEFAULT_TIMEOUT = Duration.minutes(2);
// How often to remind the user that a lock wait / locked operation is still
// outstanding. Long enough that healthy runs never print it.
const STALL_INTERVAL = Duration.seconds(30);

class LockHeld extends Data.TaggedError("LockHeld") {}

class LockTimeout extends Data.TaggedError("LockTimeout")<{
  readonly lockPath: string;
  readonly timeout: Duration.Input;
  readonly message: string;
}> {}

/**
 * Make a lock key safe to use as a file name on every platform.
 *
 * Keys are derived from user-controlled values (profile names), which
 * have shown up in production containing shell placeholders like
 * `${ALCHEMY_PROFILE:-default}` — `:`/`{`/`$` are invalid in Windows
 * file names and mkdir fails with EINVAL. Collapse anything outside a
 * conservative allow-list to `_`.
 *
 * @internal exported for unit testing.
 */
export const sanitizeLockKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Take the cross-process lock. On success the ambient scope owns it: a
 * finalizer removes it and a forked heartbeat keeps its mtime fresh.
 */
const acquireFileLock = Effect.fn(function* (
  lockPath: string,
  timeout: Duration.Input,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ownerPath = path.join(lockPath, "owner");
  const owner = yield* Effect.sync(() => crypto.randomUUID());

  yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });

  // Reap a lock whose crashed holder stopped refreshing its mtime.
  const reapStale = Effect.gen(function* () {
    const info = yield* fs.stat(lockPath);
    const now = yield* Clock.currentTimeMillis;
    const isStale = Option.exists(
      info.mtime,
      (mtime) => mtime.getTime() < now - Duration.toMillis(STALE),
    );
    if (isStale) {
      yield* fs.remove(lockPath, { recursive: true, force: true });
    }
  }).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));

  // A non-recursive mkdir is the atomic test-and-set; the owner marker lets
  // release and refresh verify the lock wasn't reaped and re-taken.
  yield* fs.makeDirectory(lockPath).pipe(
    Effect.andThen(
      fs
        .writeFileString(ownerPath, owner)
        .pipe(
          Effect.onError(() =>
            fs
              .remove(lockPath, { recursive: true, force: true })
              .pipe(Effect.ignore),
          ),
        ),
    ),
    Effect.catchReason("PlatformError", "AlreadyExists", () =>
      reapStale.pipe(Effect.andThen(Effect.fail(new LockHeld()))),
    ),
    Effect.retry({
      while: (error) => error._tag === "LockHeld",
      schedule: Schedule.spaced(RETRY_INTERVAL).pipe(
        Schedule.upTo({ duration: timeout }),
      ),
    }),
    Effect.catchTag("LockHeld", () =>
      Effect.die(
        new LockTimeout({
          lockPath,
          timeout,
          message:
            `Timed out waiting for the alchemy auth lock '${lockPath}' — another alchemy ` +
            `process has held it for over ${Duration.toSeconds(timeout)}s. If no other ` +
            `alchemy process is running, delete the lock directory and retry.`,
        }),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    fs.readFileString(ownerPath).pipe(
      Effect.filterOrFail((current) => current === owner),
      Effect.andThen(fs.remove(lockPath, { recursive: true, force: true })),
      Effect.ignore,
    ),
  );

  yield* fs.readFileString(ownerPath).pipe(
    Effect.filterOrFail((current) => current === owner),
    Effect.andThen(
      Clock.currentTimeMillis.pipe(Effect.map((now) => new Date(now))),
    ),
    // NB: utimes interprets a bare number as *seconds* since epoch.
    Effect.flatMap((now) => fs.utimes(lockPath, now, now)),
    Effect.repeat(Schedule.spaced(REFRESH)),
    Effect.catch(() =>
      Effect.logWarning(
        `auth lock compromised (continuing): '${lockPath}' is no longer owned by this process`,
      ),
    ),
    // Acquisition returns while this fiber refreshes until the lock scope ends.
    Effect.forkScoped,
  );
});

type Phase = { current: "waiting" | "held" };

/**
 * Periodic "I am not dead, I am stuck here" notice, forked for the lifetime
 * of a {@link withLock} call.
 *
 * Deliberately `Console.error` rather than `Effect.logWarning`: the CLI's
 * telemetry layer replaces the console logger with the OTLP one (see
 * `Telemetry/Layer.ts`), so log records reach `.alchemy/log/out` but never
 * the terminal. The whole point of this notice is to reach the user who is
 * watching a frozen terminal, so it must not go through the logger.
 */
const stallNotice = (
  lockPath: string,
  label: string,
  phase: Phase,
  interval: Duration.Input,
) =>
  Effect.suspend(() => {
    let seconds = 0;
    return Effect.suspend(() => {
      seconds += Duration.toSeconds(interval);
      return Console.error(
        phase.current === "waiting"
          ? `alchemy: ${seconds}s waiting for the auth lock '${lockPath}' (${label}). ` +
              `Another alchemy process holds it; if none is running, delete that directory.`
          : `alchemy: ${label} has been running for ${seconds}s while holding the auth lock ` +
              `'${lockPath}'. Re-run with --log-level debug for detail.`,
      );
    }).pipe(Effect.delay(interval), Effect.repeat(Schedule.spaced(interval)));
  });

/**
 * Serialise execution of `effect` for the same `key`, both within this
 * process (a semaphore) and across processes on the same machine (an atomic
 * lock directory whose mtime is refreshed while held so another process can
 * recover it after a crash).
 *
 * Failure to create or acquire the lock is fatal. Authentication writes its
 * profile state beneath the same root, so continuing without a writable lock
 * cannot produce a valid deployment and would permit concurrent corruption.
 */
export const withLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
  options?: {
    readonly timeout?: Duration.Input;
    /**
     * Human-readable name of the work being serialised, used in the debug
     * log lines and the stall notice. Defaults to `key`.
     */
    readonly label?: string;
    /**
     * Print a periodic notice to stderr while this lock is being waited on
     * or held (see {@link stallNotice}). Pass `false` for flows that
     * legitimately block on the user — a browser OAuth round-trip, an
     * `aws sso login` child process — where a repeating notice would be
     * both wrong and destructive to the prompt on screen.
     *
     * @default true
     */
    readonly watchdog?: boolean;
    /**
     * Interval between stall notices.
     *
     * @internal exposed so tests need not wait 30 real seconds.
     */
    readonly stallInterval?: Duration.Input;
  },
) => {
  const safeKey = sanitizeLockKey(key);
  const label = options?.label ?? key;
  let semaphore = semaphores.get(safeKey);
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1);
    semaphores.set(safeKey, semaphore);
  }
  return semaphore.withPermit(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // Read `rootDir` here, not at module eval, so the
      // `Profile -> AuthProvider -> Lock -> Profile` import cycle never
      // sees it uninitialised.
      const lockPath = path.join(rootDir, "lock", `${safeKey}.lock`);
      const phase: Phase = { current: "waiting" };
      if (options?.watchdog !== false) {
        yield* Effect.forkScoped(
          stallNotice(
            lockPath,
            label,
            phase,
            options?.stallInterval ?? STALL_INTERVAL,
          ),
        );
      }
      yield* Effect.logDebug(`auth lock: acquiring '${lockPath}' for ${label}`);
      yield* acquireFileLock(
        lockPath,
        options?.timeout ?? DEFAULT_TIMEOUT,
      ).pipe(Effect.orDie);
      phase.current = "held";
      yield* Effect.logDebug(`auth lock: acquired '${lockPath}' for ${label}`);
      return yield* effect.pipe(
        Effect.onExit(() =>
          Effect.logDebug(`auth lock: releasing '${lockPath}' for ${label}`),
        ),
      );
    }).pipe(Effect.scoped),
  );
};

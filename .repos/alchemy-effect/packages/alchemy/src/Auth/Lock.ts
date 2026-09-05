import { lock } from "@alchemy.run/node-utils/lockfile";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "pathe";
import { rootDir } from "./Profile.ts";

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

/** File-system errors that mean "we cannot lock here at all". */
const UNLOCKABLE_FS_CODES = new Set(["EROFS", "EACCES", "EPERM", "ENOSPC"]);

/**
 * Serialise execution of `effect` so no two callers ever run inside the
 * critical section concurrently for the same `key`, both within this
 * process and across other processes on the same machine.
 *
 * Uses `@alchemy.run/node-utils` lockfile for both: it tracks in-process
 * holders by path (so same-process callers wait via `retries`) and uses
 * an OS file lock for cross-process coordination, with stale-lock
 * detection at 60s.
 *
 * Locking is best-effort: on file systems where the lock directory
 * cannot be created at all (read-only home in containers/CI), the
 * effect runs unserialised with a warning instead of failing — a
 * missed lock only risks a redundant credential refresh.
 */
export const withLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  // Computed lazily (not at module-eval time) so that the
  // `Profile -> AuthProvider -> Lock -> Profile` import cycle never reads
  // `rootDir` before `Profile.ts` has finished initialising it.
  const lockDir = path.join(rootDir, "lock");
  const lockPath = path.join(lockDir, `${sanitizeLockKey(key)}.lock`);
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      try {
        await fs.mkdir(lockDir, { recursive: true });
        return await lock(lockPath, {
          // A full single-process test run can build hundreds of provider
          // layers concurrently. Each credential read briefly takes this
          // lock, so tail waiters need enough budget to drain that queue.
          retries: { retries: 2_400, minTimeout: 50, maxTimeout: 50 },
          // The holder refreshes the lockfile mtime on a timer. Under heavy
          // load (e.g. a full test run saturating every core) that timer can
          // be starved for several seconds, so keep the stale threshold well
          // above any realistic starvation pause.
          stale: 30_000,
          realpath: false,
          // The library's default handler throws from a timer callback,
          // which surfaces as an uncaught exception and kills the process.
          // A compromised auth lock is benign here (worst case two refreshes
          // race), so log and continue.
          onCompromised: (err) => {
            console.warn(`auth lock compromised (continuing): ${err.message}`);
          },
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== undefined && UNLOCKABLE_FS_CODES.has(code)) {
          console.warn(
            `auth lock unavailable (${code} at '${lockPath}') — continuing without cross-process locking`,
          );
          return async () => {};
        }
        if (
          err instanceof Error &&
          err.message.includes("already being held")
        ) {
          throw new Error(
            `Timed out waiting for the alchemy auth lock '${lockPath}' — another alchemy ` +
              `process has held it for over 120s. If no other alchemy process is running, ` +
              `delete the lock file and retry.`,
            { cause: err },
          );
        }
        throw err;
      }
    }),
    () => effect,
    (release) => Effect.promise(() => release().catch(() => {})),
  );
};

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { tmpdir } from "node:os";
import { join } from "node:path";

// API Gateway REST has a very low account-wide control-plane mutation quota,
// especially for deleting REST APIs. The authoritative AWS sweep runs a
// distributed lane and a Lambda-quota lane in separate Bun processes; an
// in-memory semaphore cannot coordinate a RestApiEventSource test in one lane
// with ordinary ApiGateway tests in the other. Use one service-local,
// cross-process lock directory instead. Unrelated AWS services remain fully
// parallel.
const profile = (process.env.ALCHEMY_PROFILE ?? "testing").replace(
  /[^a-zA-Z0-9_.-]/g,
  "-",
);
const uid = process.getuid?.() ?? 0;
const lockDirectory = join(
  tmpdir(),
  `alchemy-test-apigateway-${uid}-${profile}.lock`,
);
const ownerFile = join(lockDirectory, "owner");

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const pollInterval = "250 millis";
// A freshly-acquired lock writes its owner file immediately after the atomic
// mkdir, so an unreadable owner is normally a sub-second race. If it stays
// unreadable for this many consecutive polls (~10s) the lock predates a crash
// or reboot that corrupted the directory (reads can then fail with
// EFAULT/ENOENT/EPERM in bun) and it is treated as stale.
const unreadableStalePolls = 40;

/**
 * Cross-process test lease over a tmpdir lock directory.
 *
 * Robustness contract: NO filesystem failure may escape into the test run.
 * A machine reboot can leave the lock directory in a state where even
 * `rm`/`read` fail with EFAULT (observed bun edge case on stale tmp entries);
 * every fs primitive below is therefore best-effort, and a stale lock whose
 * removal keeps failing is stolen in place by overwriting the owner file.
 */
export const makeApiGatewayTestLease = () => {
  let held = false;

  const acquire = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const tryMakeDir = fs.makeDirectory(lockDirectory).pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    const tryWriteOwner = fs
      .writeFileString(ownerFile, String(process.pid))
      .pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
    const tryReadOwnerPid = fs.readFileString(ownerFile).pipe(
      Effect.map((content) => Number.parseInt(content, 10)),
      Effect.catchCause(() => Effect.succeed<number | undefined>(undefined)),
    );
    const tryRemoveLock = fs.remove(lockDirectory, { recursive: true }).pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );

    let unreadablePolls = 0;

    while (true) {
      if (yield* tryMakeDir) {
        if (yield* tryWriteOwner) {
          held = true;
          return;
        }
        // We created the directory but could not record ownership. Back out
        // (best-effort) so other processes are not stuck waiting on a
        // headless lock, then retry.
        yield* tryRemoveLock;
        yield* Effect.sleep(pollInterval);
        continue;
      }

      // The directory already exists — or mkdir itself failed abnormally
      // (e.g. EFAULT on a reboot-stale path). Inspect the recorded owner.
      const ownerPid = yield* tryReadOwnerPid;

      if (
        ownerPid !== undefined &&
        Number.isFinite(ownerPid) &&
        processIsAlive(ownerPid)
      ) {
        unreadablePolls = 0;
        yield* Effect.sleep(pollInterval);
        continue;
      }

      if (ownerPid === undefined) {
        // Missing or unreadable owner file: give the current owner a grace
        // window to finish writing it before declaring the lock stale.
        unreadablePolls += 1;
        if (unreadablePolls < unreadableStalePolls) {
          yield* Effect.sleep(pollInterval);
          continue;
        }
      }

      // Stale lock: the owner is dead, invalid, or unreadable past the grace
      // window. Prefer removing the directory so the atomic-mkdir path can
      // re-acquire; if removal itself keeps failing (EFAULT on the stale
      // directory), steal in place by overwriting the owner file and
      // verifying we won any concurrent write race.
      unreadablePolls = 0;
      if (yield* tryRemoveLock) {
        continue;
      }
      if (yield* tryWriteOwner) {
        yield* Effect.sleep("100 millis");
        if ((yield* tryReadOwnerPid) === process.pid) {
          held = true;
          return;
        }
      }
      yield* Effect.sleep(pollInterval);
    }
  });

  const release = Effect.gen(function* () {
    if (!held) return;
    held = false;
    const fs = yield* FileSystem.FileSystem;
    const removed = yield* fs.remove(lockDirectory, { recursive: true }).pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!removed) {
      // Could not remove the directory (stale-tmp EFAULT). Best-effort drop
      // of the owner file so a successor's staleness detection steals the
      // lock instead of waiting on this (soon-dead) pid. Never fail release.
      yield* fs.remove(ownerFile).pipe(Effect.catchCause(() => Effect.void));
    }
  });

  return { acquire, release };
};

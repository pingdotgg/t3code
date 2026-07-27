import { lock } from "@alchemy.run/node-utils/lockfile";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { tmpdir } from "node:os";
import path from "pathe";

// AWS permits only one ACCOUNT_UNUSED_ACCESS analyzer per account and Region.
// The lifecycle and binding files both exercise that singleton, while
// alchemy-test runs files concurrently in one process, and the full AWS sweep
// intentionally runs its distributed and Lambda-heavy lanes as separate Bun
// processes. Hold both an in-process semaphore and an OS-backed lock from a
// file's root beforeAll through its root afterAll so setup and teardown cannot
// overlap across either boundary.
const accessAnalyzerTestLock = Semaphore.makeUnsafe(1);
const accessAnalyzerTestLockPath = path.join(
  tmpdir(),
  "alchemy-test-access-analyzer-unused-access",
);

export const makeAccessAnalyzerTestLease = () => {
  let held = false;
  let releaseFileLock: (() => Promise<void>) | undefined;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(accessAnalyzerTestLock.take(1));
        held = true;

        releaseFileLock = yield* restore(
          Effect.tryPromise(() =>
            lock(accessAnalyzerTestLockPath, {
              realpath: false,
              stale: 60_000,
              retries: {
                retries: 4_500,
                minTimeout: 50,
                maxTimeout: 50,
              },
              onCompromised: (error) => {
                console.warn(
                  `AccessAnalyzer test lock compromised: ${error.message}`,
                );
              },
            }),
          ).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) return Effect.void;
              held = false;
              return accessAnalyzerTestLock.release(1).pipe(Effect.asVoid);
            }),
          ),
        );
      }),
    ),
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      const release = releaseFileLock;
      releaseFileLock = undefined;
      return (
        release === undefined
          ? Effect.void
          : Effect.tryPromise(() => release()).pipe(
              // Teardown must still release the in-process permit if stale
              // lock cleanup already removed the OS lock.
              Effect.catch(() => Effect.void),
            )
      ).pipe(Effect.ensuring(accessAnalyzerTestLock.release(1)), Effect.asVoid);
    }),
  };
};

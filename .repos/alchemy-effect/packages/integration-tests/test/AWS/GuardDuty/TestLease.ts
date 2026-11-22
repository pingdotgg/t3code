import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// GuardDuty permits one detector per account and Region. The lifecycle,
// detector-resource, and bindings files all create that singleton while
// alchemy-test executes files concurrently in one process. Hold this lease
// from each file's root beforeAll through its root afterAll so detector
// observation, fixture setup, and cleanup cannot overlap across the files.
const guardDutyTestLock = Semaphore.makeUnsafe(1);

export const makeGuardDutyTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(guardDutyTestLock.take(1)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            held = true;
          }),
        ),
        Effect.asVoid,
      ),
    ),
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      return guardDutyTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

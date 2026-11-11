import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// Telemetry evaluation is an account-wide singleton, and AWS also rejects
// concurrently managed rules with identical configurations even when their
// names differ. alchemy-test runs files concurrently in one process, so hold
// this lease from each file's root beforeAll through its root afterAll. This
// keeps setup, lifecycle assertions, and capture-and-restore cleanup atomic
// across the ObservabilityAdmin service tests.
const observabilityAdminTestLock = Semaphore.makeUnsafe(1);

export const makeObservabilityAdminTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(observabilityAdminTestLock.take(1)).pipe(
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
      return observabilityAdminTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

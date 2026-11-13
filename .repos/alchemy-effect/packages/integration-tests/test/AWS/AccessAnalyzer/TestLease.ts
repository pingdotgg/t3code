import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// AWS permits only one ACCOUNT_UNUSED_ACCESS analyzer per account and Region.
// The test runner executes files concurrently in one process, so hold this
// semaphore across each suite's beforeAll → afterAll lifecycle.
const accessAnalyzerTestLock = Semaphore.makeUnsafe(1);

export const makeAccessAnalyzerTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(accessAnalyzerTestLock.take(1)).pipe(
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
      return accessAnalyzerTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

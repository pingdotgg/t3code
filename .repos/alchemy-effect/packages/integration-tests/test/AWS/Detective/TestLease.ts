import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// Detective permits one behavior graph per account and Region. The lifecycle
// and bindings files both create that singleton while alchemy-test executes
// files concurrently in one process. Hold this lease from each file's root
// beforeAll through its root afterAll so graph observation, fixture setup, and
// cleanup cannot overlap across the two files.
const detectiveTestLock = Semaphore.makeUnsafe(1);

export const makeDetectiveTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(detectiveTestLock.take(1)).pipe(
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
      return detectiveTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

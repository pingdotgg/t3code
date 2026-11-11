import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// Amplify throttles CreateApp account-wide and reports it as a
// BadRequestException. The resource and binding files all create an app while
// alchemy-test runs files concurrently in one process. Hold this lease from a
// file's root beforeAll through its root afterAll so those lifecycles cannot
// overlap.
const amplifyTestLock = Semaphore.makeUnsafe(1);

export const makeAmplifyTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(amplifyTestLock.take(1)).pipe(
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
      return amplifyTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

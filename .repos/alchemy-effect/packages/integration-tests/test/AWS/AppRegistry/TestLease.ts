import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// AppRegistry's account/Region control plane has a low write TPS ceiling.
// alchemy-test runs files concurrently in one process, so hold this lease for
// each file's full lifecycle. This preserves concurrency across AWS services
// while preventing AppRegistry's own create/associate/replace/delete bursts
// from throttling one another.
const appRegistryTestLock = Semaphore.makeUnsafe(1);

export const makeAppRegistryTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(appRegistryTestLock.take(1)).pipe(
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
      return appRegistryTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

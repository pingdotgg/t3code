import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// Security Hub permits one Hub per account and Region. The Hub lifecycle,
// dependent-resource lifecycle, and bindings files all create and delete that
// singleton while alchemy-test executes files concurrently in one process.
// Hold this lease for each file's complete setup/test/cleanup lifecycle so one
// file cannot observe, adopt, throttle, or disable another file's Hub.
const securityHubTestLock = Semaphore.makeUnsafe(1);

export const makeSecurityHubTestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(securityHubTestLock.take(1)).pipe(
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
      return securityHubTestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

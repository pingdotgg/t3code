import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// AWS Config permits one customer-managed configuration recorder and one
// delivery channel per account and Region. ConfigRule.test.ts, Bindings.test.ts,
// and the gated recorder lifecycle all mutate that shared service state while
// alchemy-test executes files concurrently in one process. Read-only probes do
// not need this lease; callers hold it only around recorder/channel-dependent
// lifecycle work and its cleanup.
const configTestLock = Semaphore.makeUnsafe(1);

export const makeConfigTestLease = () => {
  let held = false;

  const acquire = Effect.uninterruptibleMask((restore) =>
    restore(configTestLock.take(1)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          held = true;
        }),
      ),
      Effect.asVoid,
    ),
  );

  const release = Effect.suspend(() => {
    if (!held) return Effect.void;
    held = false;
    return configTestLock.release(1).pipe(Effect.asVoid);
  });

  return {
    acquire,
    release,
    use: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquire,
        () => effect,
        () => release,
      ),
  };
};

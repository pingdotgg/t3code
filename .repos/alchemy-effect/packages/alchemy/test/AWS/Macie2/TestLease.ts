import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// Amazon Macie exposes one session per account and Region. The session,
// resource, classification-job, and bindings files all enable/disable or
// depend on that singleton while alchemy-test executes files concurrently in
// one process. Hold this lease for each file's complete setup → test → cleanup
// lifecycle so one file cannot disable Macie underneath another.
const macie2TestLock = Semaphore.makeUnsafe(1);

export const makeMacie2TestLease = () => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(macie2TestLock.take(1)).pipe(
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
      return macie2TestLock.release(1).pipe(Effect.asVoid);
    }),
  };
};

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export interface SnapshotSubscription<A> {
  readonly latest: A;
  readonly changes: Stream.Stream<A>;
}

export const subscribeBeforeSnapshot = Effect.fn("subscribeBeforeSnapshot")(function* <A, E, R>(
  changes: PubSub.PubSub<A>,
  snapshot: Effect.Effect<A, E, R>,
  mutex: Semaphore.Semaphore,
) {
  return yield* mutex.withPermits(1)(
    Effect.gen(function* () {
      const latest = yield* snapshot;
      const subscription = yield* PubSub.subscribe(changes);
      return {
        latest,
        changes: Stream.fromSubscription(subscription),
      } satisfies SnapshotSubscription<A>;
    }),
  );
});

export const subscribeBeforeSnapshotWithoutMutex = Effect.fn("subscribeBeforeSnapshotWithoutMutex")(
  function* <A, E, R>(changes: PubSub.PubSub<A>, snapshot: Effect.Effect<A, E, R>) {
    const subscription = yield* PubSub.subscribe(changes);
    const latest = yield* snapshot;
    return {
      latest,
      changes: Stream.fromSubscription(subscription),
    } satisfies SnapshotSubscription<A>;
  },
);

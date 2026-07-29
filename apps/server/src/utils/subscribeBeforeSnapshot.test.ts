import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  subscribeBeforeSnapshot,
  subscribeBeforeSnapshotWithoutMutex,
} from "./subscribeBeforeSnapshot.ts";

describe("subscribeBeforeSnapshot", () => {
  it.effect("atomically reads the initial snapshot before receiving later changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.sliding<number>(1);
        const latest = yield* Ref.make(1);
        const mutex = yield* Semaphore.make(1);
        const snapshotStarted = yield* Deferred.make<void>();
        const finishSnapshot = yield* Deferred.make<void>();
        const subscriptionFiber = yield* subscribeBeforeSnapshot(
          changes,
          Deferred.succeed(snapshotStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishSnapshot)),
            Effect.andThen(Ref.get(latest)),
          ),
          mutex,
        ).pipe(Effect.forkChild);

        yield* Deferred.await(snapshotStarted);
        const publishFiber = yield* mutex
          .withPermits(1)(Ref.set(latest, 2).pipe(Effect.andThen(PubSub.publish(changes, 2))))
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(finishSnapshot, undefined);

        const subscription = yield* Fiber.join(subscriptionFiber);
        yield* Fiber.join(publishFiber);
        const firstChange = yield* subscription.changes.pipe(
          Stream.runHead,
          Effect.timeout("1 second"),
        );

        expect(subscription.latest).toBe(1);
        expect(firstChange).toEqual(Option.some(2));
      }),
    ),
  );

  it.effect("subscribes before an uncoordinated snapshot can change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.sliding<number>(1);
        const latest = yield* Ref.make(1);
        const snapshotStarted = yield* Deferred.make<void>();
        const finishSnapshot = yield* Deferred.make<void>();
        const subscriptionFiber = yield* subscribeBeforeSnapshotWithoutMutex(
          changes,
          Deferred.succeed(snapshotStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishSnapshot)),
            Effect.andThen(Ref.get(latest)),
          ),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(snapshotStarted);
        yield* Ref.set(latest, 2);
        yield* PubSub.publish(changes, 2);
        yield* Deferred.succeed(finishSnapshot, undefined);

        const subscription = yield* Fiber.join(subscriptionFiber);
        const firstChange = yield* subscription.changes.pipe(
          Stream.runHead,
          Effect.timeout("1 second"),
        );

        expect(subscription.latest).toBe(2);
        expect(firstChange).toEqual(Option.some(2));
      }),
    ),
  );
});

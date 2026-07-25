import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { ServiceUpdateCoordinator, layer, make } from "./serviceUpdateCoordinator.ts";

it.effect("enters draining only after an admitted start finishes and keeps accepting starts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const coordinator = yield* make;
      const admitted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const start = yield* coordinator
        .withTurnAdmission(
          Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(admitted);
      const drain = yield* coordinator
        .beginDrain({
          targetVersion: "0.0.29",
          activeTurnCount: 1,
          startedAt: "2026-07-25T13:23:25.000Z",
        })
        .pipe(Effect.forkScoped);
      assert.isFalse(yield* coordinator.isDraining);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(start);
      yield* Fiber.join(drain);
      assert.isTrue(yield* coordinator.isDraining);

      yield* coordinator.withTurnAdmission(Effect.void);
      yield* coordinator.withActivationHandoff(Effect.void);
      yield* coordinator.cancelDrain;
      yield* coordinator.withTurnAdmission(Effect.void);
    }),
  ),
);

it.effect("projects live active and queued counts through activation and cancellation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const coordinator = yield* make;
      const statesFiber = yield* coordinator.changes.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* coordinator.beginDrain({
        targetVersion: "0.0.29",
        activeTurnCount: 3,
        startedAt: "2026-07-25T13:23:25.000Z",
      });
      yield* coordinator.updateActiveTurnCount(2);
      yield* coordinator.queueTurn({
        threadId: "thread-1" as never,
        messageId: "message-1" as never,
      });
      yield* coordinator.queueTurn({
        threadId: "thread-1" as never,
        messageId: "message-1" as never,
      });
      yield* coordinator.markActivating;

      const states = Array.from(yield* Fiber.join(statesFiber));
      assert.deepEqual(
        states.map((state) => state.status),
        ["idle", "draining", "draining", "draining", "activating"],
      );
      assert.equal(states[3]?.status === "draining" ? states[3].queuedTurnCount : -1, 1);
      assert.equal(states[4]?.status === "activating" ? states[4].queuedTurnCount : -1, 1);
      assert.isFalse(yield* coordinator.cancelDrain);
    }),
  ),
);

it.effect("provides the coordinator through its service tag", () =>
  Effect.gen(function* () {
    const coordinator = yield* ServiceUpdateCoordinator;
    assert.isFalse(yield* coordinator.isDraining);
  }).pipe(Effect.provide(layer)),
);

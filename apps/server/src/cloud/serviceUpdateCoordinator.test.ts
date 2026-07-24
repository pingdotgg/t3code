import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

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
      const drain = yield* coordinator.beginDrain.pipe(Effect.forkScoped);
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

it.effect("provides the coordinator through its service tag", () =>
  Effect.gen(function* () {
    const coordinator = yield* ServiceUpdateCoordinator;
    assert.isFalse(yield* coordinator.isDraining);
  }).pipe(Effect.provide(layer)),
);

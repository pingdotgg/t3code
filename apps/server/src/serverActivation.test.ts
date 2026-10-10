import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import * as ServerActivation from "./serverActivation.ts";

it.effect("proves a root is parked before returning and releases it with one gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      yield* ServerActivation.forkParked(Deferred.succeed(ran, undefined)).pipe(
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      );
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
      expect(yield* Deferred.isDone(ran)).toBe(true);
    }),
  ),
);

it.effect("defers maintenance until the client loads and staggers its startup work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const firstRan = yield* Deferred.make<void>();
      const secondRan = yield* Deferred.make<void>();
      const background = yield* ServerActivation.makeBackgroundStart(Deferred.await(activation));
      yield* ServerActivation.forkBackground(Deferred.succeed(firstRan, undefined)).pipe(
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
        Effect.provideService(ServerActivation.ServerBackgroundStart, background),
      );
      yield* ServerActivation.forkBackground(Deferred.succeed(secondRan, undefined)).pipe(
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
        Effect.provideService(ServerActivation.ServerBackgroundStart, background),
      );
      yield* Deferred.succeed(activation, undefined);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Deferred.isDone(firstRan)).toBe(false);
      expect(yield* Deferred.isDone(secondRan)).toBe(false);
      yield* background.markClientServed;
      yield* Deferred.await(firstRan);
      expect(yield* Deferred.isDone(secondRan)).toBe(false);
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(secondRan);
    }),
  ),
);

it.effect("eventually starts probes and maintenance even when no client connects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const background = yield* ServerActivation.makeBackgroundStart(Effect.void);
      const firstClient = yield* background.awaitFirstClient.pipe(Effect.forkScoped);
      const maintenance = yield* background.awaitTurn.pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(firstClient);
      expect(maintenance.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(maintenance);
    }),
  ),
);

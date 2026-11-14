import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ServerActivation from "./serverActivation.ts";

it.effect("keeps maintenance parked until activation and client delivery", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    const ran = yield* Deferred.make<void>();
    const background = yield* ServerActivation.makeBackgroundStart(Deferred.await(activation));
    yield* ServerActivation.forkBackground(Deferred.succeed(ran, undefined)).pipe(
      Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      Effect.provideService(ServerActivation.ServerBackgroundStart, background),
    );

    yield* TestClock.adjust("1 minute");
    expect(yield* Deferred.isDone(ran)).toBe(false);
    yield* Deferred.succeed(activation, undefined);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Deferred.isDone(ran)).toBe(false);

    yield* background.markClientServed;
    yield* Deferred.await(ran);
  }),
);

it.effect("releases background work after the fallback when no client connects", () =>
  Effect.gen(function* () {
    const background = yield* ServerActivation.makeBackgroundStart(Effect.void);
    const waiter = yield* background.awaitTurn.pipe(Effect.forkScoped);
    yield* TestClock.adjust("29 seconds");
    expect(waiter.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(waiter);
  }),
);

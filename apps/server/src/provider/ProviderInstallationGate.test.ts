import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex");

it.effect("queues work that starts while an update waits for in-flight work", () =>
  Effect.gen(function* () {
    const gate = yield* ProviderInstallationGate.ProviderInstallationGate;
    const inFlightStarted = yield* Deferred.make<void>();
    const releaseInFlight = yield* Deferred.make<void>();
    const log: Array<string> = [];

    const inFlight = yield* gate
      .execute(
        INSTANCE_ID,
        Deferred.succeed(inFlightStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInFlight)),
          Effect.andThen(Effect.sync(() => log.push("in-flight work finished"))),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(inFlightStarted);
    // Starting immediately runs each fiber until it blocks: the update while draining in-flight
    // work, by which point it holds the turnstile, and later work at the gate.
    const update = yield* gate
      .update(
        [INSTANCE_ID],
        Effect.sync(() => log.push("update ran")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }));
    const later = yield* gate
      .execute(
        INSTANCE_ID,
        Effect.sync(() => log.push("later work ran")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(releaseInFlight, undefined);
    yield* Fiber.join(inFlight);
    yield* Fiber.join(update);
    yield* Fiber.join(later);

    assert.deepStrictEqual(log, ["in-flight work finished", "update ran", "later work ran"]);
  }).pipe(Effect.provide(ProviderInstallationGate.layer)),
);

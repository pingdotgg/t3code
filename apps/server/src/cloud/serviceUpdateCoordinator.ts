import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

/**
 * Serializes the transition into update-pending with turn admission. Turn
 * starts continue to be persisted while draining; provider execution is
 * deferred by the provider command reactor until the replacement process
 * replays pending starts.
 */
export class ServiceUpdateCoordinator extends Context.Service<
  ServiceUpdateCoordinator,
  {
    readonly withTurnAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly withActivationHandoff: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly beginDrain: Effect.Effect<void>;
    readonly cancelDrain: Effect.Effect<void>;
    readonly isDraining: Effect.Effect<boolean>;
  }
>()("t3/cloud/ServiceUpdateCoordinator") {}

export const make = Effect.gen(function* () {
  const draining = yield* Ref.make(false);
  const admissionLock = yield* Semaphore.make(1);

  const withTurnAdmission: ServiceUpdateCoordinator["Service"]["withTurnAdmission"] = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => admissionLock.withPermits(1)(effect);

  return ServiceUpdateCoordinator.of({
    withTurnAdmission,
    withActivationHandoff: admissionLock.withPermits(1),
    beginDrain: admissionLock.withPermits(1)(Ref.set(draining, true)),
    cancelDrain: admissionLock.withPermits(1)(Ref.set(draining, false)),
    isDraining: Ref.get(draining),
  });
});

export const layer = Layer.effect(ServiceUpdateCoordinator, make);

/** One process-wide admission boundary, matching the process-wide pinned
 * runtime installation lock. HTTP and WebSocket dispatchers are constructed
 * independently, so a module singleton prevents them from admitting against
 * different drains. */
export const serviceUpdateCoordinator = Effect.runSync(make);

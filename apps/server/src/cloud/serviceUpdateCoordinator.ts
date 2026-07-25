import type { ServiceUpdateQueuedTurn, ServiceUpdateState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface BeginServiceUpdateDrain {
  readonly targetVersion: string;
  readonly activeTurnCount: number;
  readonly startedAt: string;
}

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
    readonly beginDrain: (input: BeginServiceUpdateDrain) => Effect.Effect<void>;
    readonly updateActiveTurnCount: (count: number) => Effect.Effect<void>;
    readonly queueTurn: (turn: ServiceUpdateQueuedTurn) => Effect.Effect<void>;
    readonly markActivating: Effect.Effect<void>;
    readonly cancelDrain: Effect.Effect<boolean>;
    readonly isDraining: Effect.Effect<boolean>;
    readonly state: Effect.Effect<ServiceUpdateState>;
    readonly changes: Stream.Stream<ServiceUpdateState>;
  }
>()("t3/cloud/ServiceUpdateCoordinator") {}

export const make = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<ServiceUpdateState>({ status: "idle" });
  const admissionLock = yield* Semaphore.make(1);

  const withTurnAdmission: ServiceUpdateCoordinator["Service"]["withTurnAdmission"] = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => admissionLock.withPermits(1)(effect);

  return ServiceUpdateCoordinator.of({
    withTurnAdmission,
    withActivationHandoff: admissionLock.withPermits(1),
    beginDrain: (input) =>
      admissionLock.withPermits(1)(
        SubscriptionRef.set(state, {
          status: "draining",
          targetVersion: input.targetVersion,
          activeTurnCount: input.activeTurnCount,
          queuedTurnCount: 0,
          queuedTurns: [],
          startedAt: input.startedAt,
        }),
      ),
    updateActiveTurnCount: (count) =>
      SubscriptionRef.modifySome(state, (current) =>
        current.status === "draining" && current.activeTurnCount !== count
          ? [undefined, Option.some({ ...current, activeTurnCount: count })]
          : [undefined, Option.none()],
      ),
    queueTurn: (turn) =>
      SubscriptionRef.modifySome(state, (current) => {
        if (current.status !== "draining") {
          return [undefined, Option.none()];
        }
        const alreadyQueued = current.queuedTurns.some(
          (queued) => queued.threadId === turn.threadId && queued.messageId === turn.messageId,
        );
        if (alreadyQueued) {
          return [undefined, Option.none()];
        }
        const queuedTurns = [...current.queuedTurns, turn];
        return [
          undefined,
          Option.some({
            ...current,
            queuedTurnCount: queuedTurns.length,
            queuedTurns,
          }),
        ] as const;
      }),
    markActivating: SubscriptionRef.modifySome(state, (current) =>
      current.status === "draining"
        ? [
            undefined,
            Option.some({
              status: "activating",
              targetVersion: current.targetVersion,
              queuedTurnCount: current.queuedTurnCount,
              queuedTurns: current.queuedTurns,
              startedAt: current.startedAt,
            }),
          ]
        : [undefined, Option.none()],
    ),
    cancelDrain: admissionLock.withPermits(1)(
      SubscriptionRef.modifySome(state, (current) =>
        current.status === "draining"
          ? [true, Option.some({ status: "idle" } as const)]
          : [false, Option.none()],
      ),
    ),
    isDraining: SubscriptionRef.get(state).pipe(
      Effect.map((current) => current.status === "draining"),
    ),
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(ServiceUpdateCoordinator, make);

/** One process-wide admission boundary, matching the process-wide pinned
 * runtime installation lock. HTTP and WebSocket dispatchers are constructed
 * independently, so a module singleton prevents them from admitting against
 * different drains. */
export const serviceUpdateCoordinator = Effect.runSync(make);

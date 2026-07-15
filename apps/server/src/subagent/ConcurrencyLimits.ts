import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { SubAgentError, type ProviderInstanceId, type SubAgentStatus } from "@t3tools/contracts";
import { CONCURRENCY_LIMITS, getModelCostTier } from "./SubAgentProviderInfo.ts";

const MAX_CONSECUTIVE_STATUS_FAILURES = 3;

interface ActiveSubAgent {
  readonly reservationId: string;
  readonly threadId?: string;
  readonly provider: ProviderInstanceId;
  readonly model: string;
  readonly startedAt: string;
}

interface ConcurrencyState {
  readonly nextReservationId: number;
  readonly active: ReadonlyMap<string, ActiveSubAgent>;
}

export interface ConcurrencyLimitsShape {
  readonly reserve: (
    provider: ProviderInstanceId,
    model: string,
  ) => Effect.Effect<string, SubAgentError>;

  readonly bindReservation: (reservationId: string, threadId: string) => Effect.Effect<void>;

  readonly release: (reservationOrThreadId: string) => Effect.Effect<void>;

  readonly monitorTurn: <E>(
    threadId: string,
    observeStatus: Effect.Effect<SubAgentStatus, E>,
  ) => Effect.Effect<void>;

  readonly getActiveCount: (model?: string) => Effect.Effect<number>;
}

export class ConcurrencyLimits extends Context.Service<ConcurrencyLimits, ConcurrencyLimitsShape>()(
  "t3/subagent/ConcurrencyLimits",
) {}

const makeConcurrencyLimits = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const state = yield* SynchronizedRef.make<ConcurrencyState>({
    nextReservationId: 1,
    active: new Map(),
  });

  const reserve: ConcurrencyLimitsShape["reserve"] = (provider, model) =>
    Effect.gen(function* () {
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      type ReservationDecision =
        | { readonly ok: true; readonly reservationId: string }
        | { readonly ok: false; readonly error: SubAgentError };
      const decision = yield* SynchronizedRef.modify(
        state,
        (current): readonly [ReservationDecision, ConcurrencyState] => {
          const totalActive = current.active.size;
          if (totalActive >= CONCURRENCY_LIMITS.global) {
            return [
              {
                ok: false,
                error: new SubAgentError({
                  reason: "concurrency-limit-exceeded",
                  description: `Global sub-agent limit reached (${totalActive}/${CONCURRENCY_LIMITS.global}). Wait for existing sub-agents to complete.`,
                }),
              },
              current,
            ] as const;
          }

          const costTier = getModelCostTier(model);
          const modelLimit = CONCURRENCY_LIMITS[costTier];
          const modelActive = Array.from(current.active.values()).filter(
            (agent) => agent.model.toLowerCase() === model.toLowerCase(),
          ).length;
          if (modelActive >= modelLimit) {
            return [
              {
                ok: false,
                error: new SubAgentError({
                  reason: "concurrency-limit-exceeded",
                  description: `Model ${model} limit reached (${modelActive}/${modelLimit}). This is a ${costTier} model with restricted concurrency.`,
                }),
              },
              current,
            ] as const;
          }

          const reservationId = `subagent-reservation-${current.nextReservationId}`;
          const nextActive = new Map(current.active);
          nextActive.set(reservationId, {
            reservationId,
            provider,
            model,
            startedAt,
          });
          return [
            { ok: true, reservationId },
            {
              nextReservationId: current.nextReservationId + 1,
              active: nextActive,
            },
          ] as const;
        },
      );

      if (!decision.ok) {
        return yield* decision.error;
      }
      return decision.reservationId;
    });

  const bindReservation: ConcurrencyLimitsShape["bindReservation"] = (reservationId, threadId) =>
    SynchronizedRef.update(state, (current) => {
      const reservation = current.active.get(reservationId);
      if (!reservation) return current;
      const nextActive = new Map(current.active);
      nextActive.set(reservationId, { ...reservation, threadId });
      return { ...current, active: nextActive };
    });

  const release: ConcurrencyLimitsShape["release"] = (reservationOrThreadId) =>
    SynchronizedRef.update(state, (current) => {
      const nextActive = new Map(current.active);
      nextActive.delete(reservationOrThreadId);
      for (const [reservationId, reservation] of nextActive) {
        if (reservation.threadId === reservationOrThreadId) {
          nextActive.delete(reservationId);
        }
      }
      return { ...current, active: nextActive };
    });

  const monitorTurn: ConcurrencyLimitsShape["monitorTurn"] = (threadId, observeStatus) =>
    Effect.gen(function* () {
      const monitor = Effect.gen(function* () {
        let consecutiveFailures = 0;
        while (true) {
          const observed = yield* Effect.exit(observeStatus);
          if (Exit.isFailure(observed)) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) {
              yield* release(threadId);
              return;
            }
          } else {
            consecutiveFailures = 0;
            if (observed.value !== "running") {
              yield* release(threadId);
              return;
            }
          }

          yield* Effect.sleep(Duration.seconds(1));
        }
      });
      yield* Effect.forkIn(monitor, scope);
    });

  const getActiveCount: ConcurrencyLimitsShape["getActiveCount"] = (model) =>
    Effect.gen(function* () {
      const current = (yield* SynchronizedRef.get(state)).active;
      if (!model) {
        return current.size;
      }
      return Array.from(current.values()).filter(
        (agent) => agent.model.toLowerCase() === model.toLowerCase(),
      ).length;
    });

  return ConcurrencyLimits.of({
    reserve,
    bindReservation,
    release,
    monitorTurn,
    getActiveCount,
  });
});

export const ConcurrencyLimitsLive = Layer.effect(ConcurrencyLimits, makeConcurrencyLimits);

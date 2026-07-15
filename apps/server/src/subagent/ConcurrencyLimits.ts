import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { CONCURRENCY_LIMITS, getModelCostTier } from "./SubAgentProviderInfo.ts";
import { SubAgentError } from "./SubAgentError.ts";

interface ActiveSubAgent {
  readonly threadId: string;
  readonly provider: ProviderInstanceId;
  readonly model: string;
  readonly startedAt: string;
}

export interface ConcurrencyLimitsShape {
  readonly checkCanSpawn: (
    provider: ProviderInstanceId,
    model: string,
  ) => Effect.Effect<void, SubAgentError>;

  readonly registerSpawn: (
    threadId: string,
    provider: ProviderInstanceId,
    model: string,
  ) => Effect.Effect<void>;

  readonly unregisterSpawn: (threadId: string) => Effect.Effect<void>;

  readonly getActiveCount: (model?: string) => Effect.Effect<number>;
}

export class ConcurrencyLimits extends Context.Service<ConcurrencyLimits, ConcurrencyLimitsShape>()(
  "t3/subagent/ConcurrencyLimits",
) {}

const makeConcurrencyLimits = Effect.gen(function* () {
  const active = yield* SynchronizedRef.make<ReadonlyMap<string, ActiveSubAgent>>(new Map());

  const checkCanSpawn: ConcurrencyLimitsShape["checkCanSpawn"] = (provider, model) =>
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(active);
      const totalActive = current.size;

      // Check global limit
      if (totalActive >= CONCURRENCY_LIMITS.global) {
        return yield* new SubAgentError({
          reason: "concurrency-limit-exceeded",
          description: `Global sub-agent limit reached (${totalActive}/${CONCURRENCY_LIMITS.global}). Wait for existing sub-agents to complete.`,
        });
      }

      // Check per-model limit
      const costTier = getModelCostTier(model);
      const modelLimit = CONCURRENCY_LIMITS[costTier];
      const modelActive = Array.from(current.values()).filter(
        (agent) => agent.model.toLowerCase() === model.toLowerCase(),
      ).length;

      if (modelActive >= modelLimit) {
        return yield* new SubAgentError({
          reason: "concurrency-limit-exceeded",
          description: `Model ${model} limit reached (${modelActive}/${modelLimit}). This is a ${costTier} model with restricted concurrency.`,
        });
      }
    });

  const registerSpawn: ConcurrencyLimitsShape["registerSpawn"] = (threadId, provider, model) =>
    SynchronizedRef.update(active, (current) => {
      const next = new Map(current);
      next.set(threadId, {
        threadId,
        provider,
        model,
        startedAt: new Date().toISOString(),
      });
      return next;
    });

  const unregisterSpawn: ConcurrencyLimitsShape["unregisterSpawn"] = (threadId) =>
    SynchronizedRef.update(active, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  const getActiveCount: ConcurrencyLimitsShape["getActiveCount"] = (model) =>
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(active);
      if (!model) {
        return current.size;
      }
      return Array.from(current.values()).filter(
        (agent) => agent.model.toLowerCase() === model.toLowerCase(),
      ).length;
    });

  return ConcurrencyLimits.of({
    checkCanSpawn,
    registerSpawn,
    unregisterSpawn,
    getActiveCount,
  });
});

export const ConcurrencyLimitsLive = Layer.effect(ConcurrencyLimits, makeConcurrencyLimits);

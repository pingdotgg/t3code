import type { ProviderInstanceId } from "@t3tools/contracts";
import {
  DEFAULT_UNKNOWN_RESET_COOLDOWN_MS,
  type UsageLimitCooldownEntry,
} from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface UsageLimitCooldownStoreShape {
  readonly record: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly failedAtMs: number;
    readonly resetAt: string | null;
  }) => Effect.Effect<void>;
  readonly clear: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }) => Effect.Effect<void>;
  readonly getActive: (nowMs: number) => Effect.Effect<ReadonlyArray<UsageLimitCooldownEntry>>;
  readonly findActive: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly nowMs: number;
  }) => Effect.Effect<UsageLimitCooldownEntry | null>;
}

export class UsageLimitCooldownStore extends Context.Service<
  UsageLimitCooldownStore,
  UsageLimitCooldownStoreShape
>()("t3/orchestration-v2/UsageLimitCooldownStore") {}

const keyOf = (instanceId: ProviderInstanceId, model: string) => `${instanceId}\0${model}`;

const make = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<string, UsageLimitCooldownEntry>());

  const record: UsageLimitCooldownStoreShape["record"] = ({
    instanceId,
    model,
    failedAtMs,
    resetAt,
  }) => {
    const parsedReset = resetAt !== null ? Date.parse(resetAt) : Number.NaN;
    const resetsAtMs =
      Number.isFinite(parsedReset) && parsedReset > failedAtMs
        ? parsedReset
        : failedAtMs + DEFAULT_UNKNOWN_RESET_COOLDOWN_MS;
    const next: UsageLimitCooldownEntry = {
      instanceId,
      model,
      failedAtMs,
      resetsAtMs,
      resetAt: Number.isFinite(parsedReset) && parsedReset > failedAtMs ? resetAt : null,
    };
    return Ref.update(entries, (current) => {
      const updated = new Map(current);
      const key = keyOf(instanceId, model);
      const previous = updated.get(key);
      if (previous !== undefined && previous.resetsAtMs > next.resetsAtMs) {
        return current;
      }
      updated.set(key, next);
      return updated;
    });
  };

  const clear: UsageLimitCooldownStoreShape["clear"] = ({ instanceId, model }) =>
    Ref.update(entries, (current) => {
      const key = keyOf(instanceId, model);
      if (!current.has(key)) return current;
      const updated = new Map(current);
      updated.delete(key);
      return updated;
    });

  const getActive: UsageLimitCooldownStoreShape["getActive"] = (nowMs) =>
    Ref.modify(entries, (current) => {
      let pruned = false;
      const active: Array<UsageLimitCooldownEntry> = [];
      for (const entry of current.values()) {
        if (entry.resetsAtMs > nowMs) {
          active.push(entry);
        } else {
          pruned = true;
        }
      }
      if (!pruned) return [active, current] as const;
      const updated = new Map<string, UsageLimitCooldownEntry>();
      for (const entry of active) {
        updated.set(keyOf(entry.instanceId, entry.model), entry);
      }
      return [active, updated] as const;
    });

  const findActive: UsageLimitCooldownStoreShape["findActive"] = ({ instanceId, model, nowMs }) =>
    getActive(nowMs).pipe(
      Effect.map(
        (active) =>
          active.find((entry) => entry.instanceId === instanceId && entry.model === model) ?? null,
      ),
    );

  return UsageLimitCooldownStore.of({ record, clear, getActive, findActive });
});

export const layer: Layer.Layer<UsageLimitCooldownStore> = Layer.effect(
  UsageLimitCooldownStore,
  make,
);

/**
 * ProviderRuntimeLivenessLive - in-memory provider runtime observation ledger.
 *
 * @module ProviderRuntimeLivenessLive
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Ref } from "effect";

import {
  ProviderRuntimeLiveness,
  type ProviderRuntimeLivenessShape,
  type ProviderThreadRuntimeObservation,
} from "../Services/ProviderRuntimeLiveness.ts";

/** Terminal-per-turn provider events: the turn has a known outcome. */
const SETTLING_EVENT_TYPES: ReadonlySet<ProviderRuntimeEvent["type"]> = new Set([
  "turn.completed",
  "turn.aborted",
]);

/**
 * Only the turn the projection currently calls active is ever queried, so a
 * short tail is enough to cover "the projection is a few turns behind" without
 * growing per thread.
 */
const MAX_SETTLED_TURN_IDS = 8;

/**
 * Threads stop emitting once their work is done, so entries must not be kept
 * forever. Comfortably longer than the reaper's inactivity threshold (30 min)
 * so a genuinely stuck thread is still observable when a sweep asks.
 */
const OBSERVATION_TTL_MS = 2 * 60 * 60 * 1000;

interface MutableObservation {
  lastEventAtMs: number;
  readonly settledTurnIds: ReadonlySet<string>;
}

function settledTurnIdFor(event: ProviderRuntimeEvent): string | null {
  if (!SETTLING_EVENT_TYPES.has(event.type)) return null;
  return event.turnId ?? null;
}

const makeProviderRuntimeLiveness = Effect.gen(function* () {
  const observations = yield* Ref.make(new Map<string, MutableObservation>());

  const record: ProviderRuntimeLivenessShape["record"] = (event) =>
    Ref.modify(observations, (entries): [void, Map<string, MutableObservation>] => {
      const nowMs = Date.now();
      const threadId = event.threadId;
      const existing = entries.get(threadId);
      const settledTurnId = settledTurnIdFor(event);

      const settledTurnIds = new Set(existing?.settledTurnIds ?? []);
      if (settledTurnId !== null) {
        // A resumed session can re-report a terminal event for a turn already
        // in the tail; the set makes the repeat a no-op.
        settledTurnIds.add(settledTurnId);
        // Set iteration is insertion-ordered, so this drops the oldest ids.
        while (settledTurnIds.size > MAX_SETTLED_TURN_IDS) {
          const [oldest] = settledTurnIds;
          if (oldest === undefined) break;
          settledTurnIds.delete(oldest);
        }
      }

      const next = new Map(entries);
      next.set(threadId, { lastEventAtMs: nowMs, settledTurnIds });
      for (const [candidateThreadId, observation] of next) {
        if (nowMs - observation.lastEventAtMs > OBSERVATION_TTL_MS) {
          next.delete(candidateThreadId);
        }
      }
      return [undefined, next];
    });

  const observe: ProviderRuntimeLivenessShape["observe"] = (threadId) =>
    Ref.get(observations).pipe(
      Effect.map((entries): ProviderThreadRuntimeObservation | null => {
        const observation = entries.get(threadId);
        if (observation === undefined) return null;
        return {
          lastEventAtMs: observation.lastEventAtMs,
          settledTurnIds: new Set(observation.settledTurnIds),
        };
      }),
    );

  const forget: ProviderRuntimeLivenessShape["forget"] = (threadId) =>
    Ref.update(observations, (entries) => {
      const next = new Map(entries);
      next.delete(threadId);
      return next;
    });

  return { record, observe, forget } satisfies ProviderRuntimeLivenessShape;
});

export const ProviderRuntimeLivenessLive = Layer.effect(
  ProviderRuntimeLiveness,
  makeProviderRuntimeLiveness,
);

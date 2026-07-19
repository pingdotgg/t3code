import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export type ProviderFallbackTrialDecision = "accept" | "not-trial" | "reject";

export interface ProviderFallbackTrialToken {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly startedAtMs: number;
  readonly decision: Deferred.Deferred<"accept" | "reject">;
}

interface ProviderFallbackTrialState extends ProviderFallbackTrialToken {
  completedAtMs: number | undefined;
  outcome: "accept" | "reject" | undefined;
}

const TRIAL_OUTCOME_TTL_MS = 120_000;
const TRIAL_OUTCOME_CAPACITY = 10_000;
const trialStateByKey = new Map<string, ProviderFallbackTrialState>();

const trialKey = (threadId: ThreadId, instanceId: ProviderInstanceId) =>
  `${threadId}:${instanceId}`;

function pruneTrialOutcomes(nowMs: number): void {
  for (const [key, state] of trialStateByKey) {
    if (state.completedAtMs !== undefined && nowMs - state.completedAtMs > TRIAL_OUTCOME_TTL_MS) {
      trialStateByKey.delete(key);
    }
  }
  while (trialStateByKey.size >= TRIAL_OUTCOME_CAPACITY) {
    const oldestCompleted = [...trialStateByKey.entries()].find(
      ([, state]) => state.completedAtMs !== undefined,
    );
    if (!oldestCompleted) break;
    trialStateByKey.delete(oldestCompleted[0]);
  }
}

export const beginProviderFallbackTrial = Effect.fn("beginProviderFallbackTrial")(function* (
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
) {
  const startedAtMs = yield* Clock.currentTimeMillis;
  const decision = yield* Deferred.make<"accept" | "reject">();
  const token: ProviderFallbackTrialState = {
    key: trialKey(threadId, instanceId),
    threadId,
    startedAtMs,
    decision,
    completedAtMs: undefined,
    outcome: undefined,
  };
  pruneTrialOutcomes(startedAtMs);
  trialStateByKey.set(token.key, token);
  return token satisfies ProviderFallbackTrialToken;
});

export const completeProviderFallbackTrial = Effect.fn("completeProviderFallbackTrial")(function* (
  token: ProviderFallbackTrialToken,
  outcome: "accept" | "reject",
) {
  const state = trialStateByKey.get(token.key);
  if (state !== token || state.outcome !== undefined) return;
  state.outcome = outcome;
  state.completedAtMs = yield* Clock.currentTimeMillis;
  yield* Deferred.succeed(state.decision, outcome);
});

export const rejectPendingProviderFallbackTrials = Effect.fn("rejectPendingProviderFallbackTrials")(
  function* (threadId: ThreadId) {
    const pending = [...trialStateByKey.values()].filter(
      (state) => state.threadId === threadId && state.outcome === undefined,
    );
    yield* Effect.forEach(pending, (state) => completeProviderFallbackTrial(state, "reject"), {
      discard: true,
    });
  },
);

export const decideProviderFallbackTrialEvent = Effect.fn("decideProviderFallbackTrialEvent")(
  function* (threadId: ThreadId, instanceId: ProviderInstanceId, eventCreatedAt: string) {
    const state = trialStateByKey.get(trialKey(threadId, instanceId));
    if (!state) return "not-trial" as const;

    const eventTimeMs = Date.parse(eventCreatedAt);
    if (Number.isFinite(eventTimeMs) && eventTimeMs < state.startedAtMs) {
      return "not-trial" as const;
    }

    if (state.outcome === undefined) {
      return yield* Deferred.await(state.decision);
    }
    if (
      state.completedAtMs !== undefined &&
      Number.isFinite(eventTimeMs) &&
      eventTimeMs > state.completedAtMs
    ) {
      return "not-trial" as const;
    }
    return state.outcome;
  },
);

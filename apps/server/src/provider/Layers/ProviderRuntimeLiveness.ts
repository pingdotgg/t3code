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
const MAX_SETTLED_TURNS = 8;

/**
 * Threads stop emitting once their work is done, so entries must not be kept
 * forever. Comfortably longer than the reaper's inactivity threshold (30 min)
 * so a genuinely stuck thread is still observable when a sweep asks.
 */
export const PROVIDER_RUNTIME_LIVENESS_RETENTION_MS = 2 * 60 * 60 * 1000;

/**
 * `record` runs on the ingestion funnel for every event, including every
 * `content.delta`, so it must stay O(1). The sweep over all entries is
 * amortized behind this interval instead of running per event. `prune` exists
 * for callers that must not depend on unrelated provider traffic.
 */
const PRUNE_INTERVAL_MS = 60 * 1000;

interface MutableObservation {
  lastEventAtMs: number;
  /**
   * Turn the provider most recently announced with `turn.started`. Terminal
   * events that omit `turnId` settle *this* turn, mirroring how
   * `ProviderRuntimeIngestion` falls back to the session's active turn.
   */
  lastStartedTurnId: string | null;
  /** Settled turn id -> when the settle was observed. Insertion-ordered. */
  readonly settledTurns: Map<string, number>;
}

interface LedgerState {
  readonly entries: Map<string, MutableObservation>;
  lastPruneAtMs: number;
}

function newObservation(nowMs: number): MutableObservation {
  return { lastEventAtMs: nowMs, lastStartedTurnId: null, settledTurns: new Map() };
}

const makeProviderRuntimeLiveness = Effect.gen(function* () {
  const stateRef = yield* Ref.make<LedgerState>({
    entries: new Map(),
    lastPruneAtMs: 0,
  });

  const sweepExpired = (state: LedgerState, nowMs: number): void => {
    for (const [threadId, observation] of state.entries) {
      if (nowMs - observation.lastEventAtMs > PROVIDER_RUNTIME_LIVENESS_RETENTION_MS) {
        state.entries.delete(threadId);
      }
    }
  };

  // Entries are mutated in place under `Ref.modify`, the single exclusive
  // access point for this state, and `observe` copies the settled tail out
  // before returning. Nothing else aliases these objects, so a per-event Map
  // copy would be pure overhead on the hot path.
  const record: ProviderRuntimeLivenessShape["record"] = (event) =>
    Ref.modify(stateRef, (state): [void, LedgerState] => {
      const nowMs = Date.now();
      const threadId = event.threadId;
      const observation = state.entries.get(threadId) ?? newObservation(nowMs);

      if (event.type === "turn.started" && event.turnId !== undefined) {
        observation.lastStartedTurnId = event.turnId;
      }

      if (SETTLING_EVENT_TYPES.has(event.type)) {
        // Adapters legitimately omit `turnId` on terminal events:
        // `ClaudeAdapter.completeTurn` emits one whenever `context.turnState`
        // is unset, and `CodexSessionRuntime.readRouteFields` returns
        // `turnId: undefined` from its default branch for any unlisted method.
        // `ProviderRuntimeIngestion` settles those against the session's active
        // turn; the ledger has no projection access, so it settles the turn the
        // provider last announced. Trusting `event.turnId` alone would leave
        // those turns unrecorded and let the reaper interrupt a finished turn.
        const settledTurnId = event.turnId ?? observation.lastStartedTurnId;
        if (settledTurnId !== null) {
          // A resumed session can re-report a terminal event for a turn already
          // in the tail; Map.set keeps insertion order stable for a repeat.
          observation.settledTurns.delete(settledTurnId);
          observation.settledTurns.set(settledTurnId, nowMs);
          // Map iteration is insertion-ordered, so this drops the oldest ids.
          while (observation.settledTurns.size > MAX_SETTLED_TURNS) {
            const oldest = observation.settledTurns.keys().next();
            if (oldest.done === true) break;
            observation.settledTurns.delete(oldest.value);
          }
        }
      }

      observation.lastEventAtMs = nowMs;
      state.entries.set(threadId, observation);

      if (nowMs - state.lastPruneAtMs >= PRUNE_INTERVAL_MS) {
        state.lastPruneAtMs = nowMs;
        sweepExpired(state, nowMs);
      }

      return [undefined, state];
    });

  const observe: ProviderRuntimeLivenessShape["observe"] = (threadId) =>
    Ref.get(stateRef).pipe(
      Effect.map((state): ProviderThreadRuntimeObservation | null => {
        const observation = state.entries.get(threadId);
        if (observation === undefined) return null;
        return {
          lastEventAtMs: observation.lastEventAtMs,
          settledTurns: new Map(observation.settledTurns),
        };
      }),
    );

  const prune: ProviderRuntimeLivenessShape["prune"] = () =>
    Ref.modify(stateRef, (state): [void, LedgerState] => {
      state.lastPruneAtMs = Date.now();
      sweepExpired(state, state.lastPruneAtMs);
      return [undefined, state];
    });

  const forget: ProviderRuntimeLivenessShape["forget"] = (threadId) =>
    Ref.modify(stateRef, (state): [void, LedgerState] => {
      state.entries.delete(threadId);
      return [undefined, state];
    });

  return { record, observe, prune, forget } satisfies ProviderRuntimeLivenessShape;
});

export const ProviderRuntimeLivenessLive = Layer.effect(
  ProviderRuntimeLiveness,
  makeProviderRuntimeLiveness,
);

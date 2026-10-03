/**
 * ProviderRuntimeLivenessLive - in-memory provider runtime observation ledger.
 *
 * @module ProviderRuntimeLivenessLive
 */
import { Effect, Layer, Ref } from "effect";

import {
  ProviderRuntimeLiveness,
  type ProviderRuntimeLivenessShape,
  type ProviderThreadRuntimeObservation,
} from "../Services/ProviderRuntimeLiveness.ts";

/**
 * Well beyond the reaper's settled-turn hold, so nothing here is dropped while
 * still usable, without holding stale entries indefinitely.
 */
const RETENTION_MS = 60 * 60 * 1000;

/**
 * Only the turn the projection currently calls active is ever queried, so a
 * short tail covers "the projection is a few turns behind" without growing.
 */
const MAX_SETTLED_TURNS = 8;

/** Records between expiry sweeps, amortizing the O(threads) pass. */
const PRUNE_BATCH_SIZE = 256;

interface MutableObservation {
  /** Drives retention only; no consumer reads it. */
  lastLifecycleEventAtMs: number;
  /** Terminal events that omit `turnId` settle this turn. */
  lastStartedTurnId: string | null;
  readonly settledTurns: Map<string, number>;
}

interface LedgerState {
  readonly entries: Map<string, MutableObservation>;
  /** Number of `record` calls since the last sweep. */
  sincePrune: number;
}

const makeProviderRuntimeLiveness = Effect.gen(function* () {
  const stateRef = yield* Ref.make<LedgerState>({ entries: new Map(), sincePrune: 0 });

  // Entries are mutated in place under `Ref.modify`, the single exclusive access
  // point for this state; `observe` copies the tail out, so nothing aliases them.
  const record: ProviderRuntimeLivenessShape["record"] = (event) =>
    Ref.modify(stateRef, (state): [void, LedgerState] => {
      const nowMs = Date.now();
      const threadId = event.threadId;
      const observation = state.entries.get(threadId) ?? {
        lastLifecycleEventAtMs: nowMs,
        lastStartedTurnId: null,
        settledTurns: new Map<string, number>(),
      };

      if (event.type === "turn.started" && event.turnId !== undefined) {
        observation.lastStartedTurnId = event.turnId;
      }

      // Adapters omit `turnId` on terminal events (ClaudeAdapter when
      // `turnState` is unset, CodexSessionRuntime for any unlisted method).
      // Ingestion settles those against the session's active turn; with no
      // projection access, settle the turn the provider last announced.
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const settledTurnId = event.turnId ?? observation.lastStartedTurnId;
        if (settledTurnId !== null) {
          // Delete-then-set so a re-reported terminal event keeps insertion order.
          observation.settledTurns.delete(settledTurnId);
          observation.settledTurns.set(settledTurnId, nowMs);
          for (const oldest of observation.settledTurns.keys()) {
            if (observation.settledTurns.size <= MAX_SETTLED_TURNS) break;
            observation.settledTurns.delete(oldest);
          }
        }
      }

      observation.lastLifecycleEventAtMs = nowMs;
      state.entries.set(threadId, observation);

      state.sincePrune += 1;
      if (state.sincePrune >= PRUNE_BATCH_SIZE) {
        state.sincePrune = 0;
        for (const [expiredThreadId, expired] of state.entries) {
          if (nowMs - expired.lastLifecycleEventAtMs > RETENTION_MS) {
            state.entries.delete(expiredThreadId);
          }
        }
      }

      return [undefined, state];
    });

  const observe: ProviderRuntimeLivenessShape["observe"] = (threadId) =>
    Ref.get(stateRef).pipe(
      Effect.map((state): ProviderThreadRuntimeObservation | null => {
        const observation = state.entries.get(threadId);
        if (observation === undefined) return null;
        return { settledTurns: new Map(observation.settledTurns) };
      }),
    );

  return { record, observe } satisfies ProviderRuntimeLivenessShape;
});

export const ProviderRuntimeLivenessLive = Layer.effect(
  ProviderRuntimeLiveness,
  makeProviderRuntimeLiveness,
);

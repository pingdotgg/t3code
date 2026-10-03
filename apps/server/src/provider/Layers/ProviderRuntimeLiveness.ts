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
 * Threads stop producing turns once their work is done, so entries must not be
 * kept forever. The reaper only honours a settle for `settledTurnHoldMs`
 * (10 min), so anything well beyond that is unusable; this leaves several
 * multiples of headroom for slow sweeps without holding stale entries.
 */
const RETENTION_MS = 60 * 60 * 1000;

/**
 * Only the turn the projection currently calls active is ever queried, so a
 * short tail is enough to cover "the projection is a few turns behind" without
 * growing per thread.
 */
const MAX_SETTLED_TURNS = 8;

/** Records between expiry sweeps, amortizing the O(threads) pass. */
const PRUNE_BATCH_SIZE = 256;

interface MutableObservation {
  /**
   * When this thread last produced a lifecycle event. Drives retention only —
   * no consumer reads it, and `ProviderRuntimeLiveness` filters out streaming
   * traffic, so it is not a general liveness clock.
   */
  lastLifecycleEventAtMs: number;
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
  /** Number of `record` calls since the last sweep. */
  sincePrune: number;
}

const makeProviderRuntimeLiveness = Effect.gen(function* () {
  const stateRef = yield* Ref.make<LedgerState>({ entries: new Map(), sincePrune: 0 });

  // Callers filter to lifecycle events, so this runs a handful of times per turn
  // rather than once per event; it stays O(1) regardless. Entries are mutated in
  // place under
  // `Ref.modify`, the single exclusive access point for this state, and
  // `observe` copies the tail out before returning, so nothing else aliases
  // these objects. The expiry sweep is amortized across a batch of records
  // rather than running per event.
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

      // Adapters legitimately omit `turnId` on terminal events:
      // `ClaudeAdapter.completeTurn` emits one whenever `context.turnState` is
      // unset, and `CodexSessionRuntime.readRouteFields` returns
      // `turnId: undefined` from its default branch for any unlisted method.
      // `ProviderRuntimeIngestion` settles those against the session's active
      // turn; this ledger has no projection access, so it settles the turn the
      // provider last announced. Trusting `event.turnId` alone would leave those
      // turns unrecorded and let the reaper interrupt a finished turn.
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const settledTurnId = event.turnId ?? observation.lastStartedTurnId;
        if (settledTurnId !== null) {
          // A resumed session can re-report a terminal event for a turn already
          // in the tail; delete-then-set keeps insertion order stable.
          observation.settledTurns.delete(settledTurnId);
          observation.settledTurns.set(settledTurnId, nowMs);
          // Map iteration is insertion-ordered, so this drops the oldest ids.
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

/**
 * ProviderRuntimeLiveness - what the provider runtime has told us about each
 * thread, observed *ahead* of the durable projection.
 *
 * Adapters flip their in-memory session to idle before they emit the matching
 * terminal event (`OpenCodeAdapter.finishTurn` clears `activeTurnId`, then emits
 * `turn.completed`), so between those two points `providerService.listSessions()`
 * and the durable `thread.session` disagree even though nothing went wrong. A
 * reconciler comparing the two (see ProviderSessionReaper) needs to know whether
 * the provider already reported a terminal outcome for the turn the projection
 * still calls active — otherwise a healthy turn that finished seconds ago is
 * indistinguishable from a lost session.
 *
 * `record` runs in the same sequential chain immediately *before*
 * `publishRuntimeEvent`, so an observation is never behind the projection for
 * the same event. The lag this exists to absorb is entirely downstream: the
 * bounded runtime bus and the single orchestration command worker, both of
 * which sit after `record`.
 *
 * State is in-memory and intentionally not persisted: it describes what the
 * *running* process has observed, and a fresh process has observed nothing.
 *
 * @module ProviderRuntimeLiveness
 */
import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProviderThreadRuntimeObservation {
  /** Settled turn id -> when that settle was observed. Insertion-ordered. */
  readonly settledTurns: ReadonlyMap<string, number>;
}

export interface ProviderRuntimeLivenessShape {
  /**
   * Record one provider runtime event. Called on the single ingestion funnel
   * before the event is published to orchestration.
   */
  readonly record: (event: ProviderRuntimeEvent) => Effect.Effect<void>;

  /** Latest observation for a thread, or `null` when nothing was observed. */
  readonly observe: (threadId: ThreadId) => Effect.Effect<ProviderThreadRuntimeObservation | null>;
}

export class ProviderRuntimeLiveness extends Context.Service<
  ProviderRuntimeLiveness,
  ProviderRuntimeLivenessShape
>()("t3/provider/Services/ProviderRuntimeLiveness") {}

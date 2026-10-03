/**
 * ProviderRuntimeLiveness - what the provider runtime has told us about each
 * thread, observed *ahead* of the durable projection.
 *
 * Adapters flip their in-memory session to idle before they emit the matching
 * terminal event, and orchestration applies that event through a serialized
 * command queue. Between those two points `providerService.listSessions()` and
 * the durable `thread.session` disagree even though nothing went wrong. Any
 * reconciler that compares the two (see ProviderSessionReaper) needs to know
 * whether the provider already reported a terminal outcome for the turn the
 * projection still calls active — otherwise a healthy turn that finished
 * seconds ago is indistinguishable from a lost session.
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
  /**
   * Wall-clock ms of the most recent provider runtime event observed for the
   * thread. Unlike `ProviderSessionDirectory` bindings (which only move on
   * session lifecycle writes) this advances on every event, so it is a real
   * liveness signal.
   */
  readonly lastEventAtMs: number;
  /**
   * Turn ids the provider reported a terminal outcome for
   * (`turn.completed` / `turn.aborted`) mapped to when that outcome was
   * observed, bounded to the most recent ids.
   *
   * The timestamp matters: "the provider settled this turn" is only evidence of
   * a lagging projection for as long as the settle is recent. A projection that
   * never converges (a rejected terminal command, a snapshot restore) must not
   * be able to hold a reaper off forever, so a consumer bounds the hold by age.
   */
  readonly settledTurns: ReadonlyMap<string, number>;
}

export interface ProviderRuntimeLivenessShape {
  /**
   * Record one provider runtime event. Called on the single ingestion funnel
   * before the event is published to orchestration, so the observation is
   * never behind the durable projection for the same event.
   */
  readonly record: (event: ProviderRuntimeEvent) => Effect.Effect<void>;

  /** Latest observation for a thread, or `null` when nothing was observed. */
  readonly observe: (threadId: ThreadId) => Effect.Effect<ProviderThreadRuntimeObservation | null>;

  /**
   * Drop observations older than the retention window.
   *
   * `record` also prunes, but only when provider traffic arrives, so on an
   * otherwise idle server a stale entry would live forever. A reconciler calls
   * this on its own schedule so retention never depends on unrelated activity.
   */
  readonly prune: () => Effect.Effect<void>;

  /** Drop a thread's observation (session stopped, thread deleted). */
  readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
}

export class ProviderRuntimeLiveness extends Context.Service<
  ProviderRuntimeLiveness,
  ProviderRuntimeLivenessShape
>()("t3/provider/Services/ProviderRuntimeLiveness") {}

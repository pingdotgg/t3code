/**
 * ProviderRuntimeLiveness - which turns the provider has reported settled,
 * observed ahead of the durable projection.
 *
 * Adapters flip their session to idle *before* emitting the matching terminal
 * event, so between those two points the live session and the projection
 * disagree even though nothing went wrong. A reconciler comparing the two (see
 * ProviderSessionReaper) needs to tell that apart from a genuinely lost session.
 *
 * In-memory by design: a fresh process has observed nothing.
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
  /** Records one event. Callers must filter with `isLifecycleEvent` first. */
  readonly record: (event: ProviderRuntimeEvent) => Effect.Effect<void>;

  /** Latest observation for a thread, or `null` when nothing was observed. */
  readonly observe: (threadId: ThreadId) => Effect.Effect<ProviderThreadRuntimeObservation | null>;
}

/**
 * The only events that change what the ledger knows. Streaming traffic
 * (`content.delta`, `message.part.updated`, …) carries none of it, so filtering
 * keeps this ledger off the hot path.
 */
export const isLifecycleEvent = (event: ProviderRuntimeEvent): boolean =>
  event.type === "turn.started" || event.type === "turn.completed" || event.type === "turn.aborted";

export class ProviderRuntimeLiveness extends Context.Service<
  ProviderRuntimeLiveness,
  ProviderRuntimeLivenessShape
>()("t3/provider/Services/ProviderRuntimeLiveness") {}

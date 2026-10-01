/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

export interface OrchestrationAggregateReplayRange {
  readonly aggregateKind: OrchestrationEvent["aggregateKind"];
  readonly aggregateId: string;
  readonly fromSequenceExclusive: number;
  readonly toSequenceInclusive: number;
}

export interface OrchestrationAggregateReplayStats {
  readonly eventCount: number;
  readonly payloadBytes: number;
  /** A creation in this range does not prove that the aggregate still exists. */
  readonly hasCreateEvent: boolean;
}

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Read one aggregate through a captured global head, without decoding other streams. */
  readonly readAggregateRange: (
    input: OrchestrationAggregateReplayRange & { readonly limit?: number },
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Measure at most maxEvents + 1 rows without decoding payloads. The extra
   * row tells the caller to use a snapshot instead of a truncated replay.
   */
  readonly getAggregateReplayStats: (
    input: OrchestrationAggregateReplayRange & { readonly maxEvents: number },
  ) => Effect.Effect<OrchestrationAggregateReplayStats, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Check whether an aggregate has an event after a sequence, optionally
   * restricted to one event type.
   *
   * Used during replay to tell whether a later event supersedes the one being
   * applied, without streaming the rest of the log.
   */
  readonly hasEventAfter: (input: {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: string;
    readonly type?: OrchestrationEvent["type"];
    readonly sequenceExclusive: number;
  }) => Effect.Effect<boolean, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}

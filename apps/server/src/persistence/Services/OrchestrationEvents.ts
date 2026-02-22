/**
 * OrchestrationEventRepository - Repository interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventRepository
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationEventRepositoryError } from "../Errors.ts";

export interface OrchestrationEventRepositoryShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventRepositoryError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to return.
   * @returns Effect containing ordered events.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Effect.Effect<OrchestrationEvent[], OrchestrationEventRepositoryError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Effect containing all stored events.
   */
  readonly readAll: () => Effect.Effect<OrchestrationEvent[], OrchestrationEventRepositoryError>;
}

/**
 * OrchestrationEventRepository - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventRepository
 *   return yield* events.readAll()
 * })
 * ```
 */
export class OrchestrationEventRepository extends ServiceMap.Service<
  OrchestrationEventRepository,
  OrchestrationEventRepositoryShape
>()("orchestration/EventRepository") {}

/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventRepository` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationDispatchError, OrchestrationEngineError } from "./Errors.ts";
import type { OrchestrationEventRepositoryError } from "../persistence/Errors.ts";

export interface OrchestrationEngineShape {
  /**
   * Read the current in-memory orchestration snapshot.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Effect containing ordered events.
   */
  readonly replayEvents: (
    fromSequenceExclusive: number,
  ) => Effect.Effect<OrchestrationEvent[], OrchestrationEventRepositoryError, never>;

  /**
   * Validate and dispatch an unknown command payload.
   *
   * Accepts either parsed values or raw JSON strings.
   *
   * @param command - Unknown command payload.
   * @returns Effect containing the sequence of the persisted event.
   */
  readonly dispatchUnknown: (
    command: unknown,
  ) => Effect.Effect<{ sequence: number }, OrchestrationEngineError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getSnapshot()
 * })
 * ```
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("orchestration/Engine") {}

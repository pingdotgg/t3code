/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Uses Effect `Context.Tag` for dependency injection. Command dispatch,
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
import type { Effect } from "effect";

import type { OrchestrationDispatchError, OrchestrationEngineError } from "./Errors.ts";
import type { OrchestrationEventRepositoryError } from "../persistence/Errors.ts";

export interface OrchestrationEngineShape {
  /**
   * Read the current in-memory orchestration snapshot.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Effect containing ordered events.
   */
  readonly replayEvents: (
    fromSequenceExclusive: number,
  ) => Effect.Effect<OrchestrationEvent[], OrchestrationEventRepositoryError>;

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
  ) => Effect.Effect<{ sequence: number }, OrchestrationEngineError>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;

  /**
   * Subscribe to read model updates.
   *
   * @param callback - Handler invoked on every read model update.
   * @returns Effect containing an unsubscribe function.
   */
  readonly subscribeToReadModel: (
    callback: (snapshot: OrchestrationReadModel) => void,
  ) => Effect.Effect<() => void>;

  /**
   * Subscribe to domain event fan-out.
   *
   * @param callback - Handler invoked for every persisted domain event.
   * @returns Effect containing an unsubscribe function.
   */
  readonly subscribeToDomainEvents: (
    callback: (event: OrchestrationEvent) => void,
  ) => Effect.Effect<() => void>;
}

/**
 * OrchestrationEngineService - Context tag for orchestration engine access.
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

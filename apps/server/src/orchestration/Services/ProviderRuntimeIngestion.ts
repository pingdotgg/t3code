/**
 * ProviderRuntimeIngestionService - Provider runtime ingestion service interface.
 *
 * Owns background workers that consume provider runtime streams and emit
 * orchestration commands/events.
 *
 * @module ProviderRuntimeIngestionService
 */
import { type EventId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * ProviderRuntimeIngestionShape - Service API for runtime ingestion lifecycle.
 */
export interface ProviderRuntimeIngestionShape {
  /**
   * Start ingesting provider runtime events into orchestration commands.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Uses an internal queue and continues after non-interrupt failures by
   * logging warnings.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Resolves after the ingestion worker has processed the identified
   * `turn.completed` event and every event queued before it.
   */
  readonly awaitTurnCompletionProcessed: (eventId: EventId) => Effect.Effect<void>;
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("t3/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}

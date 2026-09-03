/**
 * ProviderRuntimeIngestionService - Provider runtime ingestion service interface.
 *
 * Owns background workers that consume provider runtime streams and emit
 * orchestration commands/events.
 *
 * @module ProviderRuntimeIngestionService
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

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
   *
   * Used to order work against in-flight provider events: the command reactor
   * drains before settling a thread's background tasks so an event queued
   * before Stop cannot land after the settlement row. Tests use it in place of
   * timing-sensitive sleeps. It waits for the queue to reach zero outstanding
   * items, so callers on a hot stream should bound it.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("t3/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}

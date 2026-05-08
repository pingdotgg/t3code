/**
 * CheckpointReactor - Checkpoint reaction service interface.
 *
 * Owns background workers that react to orchestration checkpoint lifecycle
 * events and apply checkpoint side effects.
 *
 * @module CheckpointReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * CheckpointReactorShape - Service API for checkpoint reactor lifecycle.
 */
export interface CheckpointReactorShape {
  /**
   * Start the checkpoint reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Consumes both orchestration-domain and provider-runtime events via an
   * internal queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * CheckpointReactor - Service tag for checkpoint reactor workers.
 */
export class CheckpointReactor extends Context.Service<CheckpointReactor, CheckpointReactorShape>()(
  "t3/orchestration/Services/CheckpointReactor",
) {}

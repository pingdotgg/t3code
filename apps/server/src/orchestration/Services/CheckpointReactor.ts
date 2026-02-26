/**
 * CheckpointReactor - Checkpoint reaction service interface.
 *
 * Owns background workers that react to orchestration checkpoint lifecycle
 * events and apply checkpoint side effects.
 *
 * @module CheckpointReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

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
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

/**
 * CheckpointReactor - Service tag for checkpoint reactor workers.
 */
export class CheckpointReactor extends ServiceMap.Service<
  CheckpointReactor,
  CheckpointReactorShape
>()("orchestration/CheckpointReactor") {}

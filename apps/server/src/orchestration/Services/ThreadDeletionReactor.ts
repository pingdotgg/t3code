/**
 * ThreadDeletionReactor - Thread deletion cleanup reactor service interface.
 *
 * Owns background workers that react to thread deletion domain events and
 * perform best-effort runtime cleanup for provider sessions and terminals.
 *
 * @module ThreadDeletionReactor
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * ThreadDeletionReactorShape - Service API for thread deletion cleanup.
 */
export interface ThreadDeletionReactorShape {
  /**
   * Start reacting to thread.deleted orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadDeletionReactor - Service tag for thread deletion cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()("t3/orchestration/Services/ThreadDeletionReactor") {}

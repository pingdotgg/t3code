/**
 * ThreadArchiveReactor - Thread archive cleanup reactor service interface.
 *
 * Owns background workers that react to thread archive domain events and
 * perform best-effort runtime cleanup for provider sessions, terminals, and
 * child (sub-agent) threads.
 *
 * @module ThreadArchiveReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadArchiveReactorShape - Service API for thread archive cleanup.
 */
export interface ThreadArchiveReactorShape {
  /**
   * Start reacting to thread.archived orchestration domain events.
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
 * ThreadArchiveReactor - Service tag for thread archive cleanup workers.
 */
export class ThreadArchiveReactor extends Context.Service<
  ThreadArchiveReactor,
  ThreadArchiveReactorShape
>()("t3/orchestration/Services/ThreadArchiveReactor") {}

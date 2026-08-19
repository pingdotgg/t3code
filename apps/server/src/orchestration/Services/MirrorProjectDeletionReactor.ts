/**
 * MirrorProjectDeletionReactor - Mirror link cleanup on project deletion.
 *
 * Reacts to `project.deleted` domain events regardless of which transport
 * dispatched the delete (WebSocket, HTTP, or the offline CLI), so a mirrored
 * project's origin always learns its link is gone.
 *
 * @module MirrorProjectDeletionReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface MirrorProjectDeletionReactorShape {
  /**
   * Start reacting to project.deleted orchestration domain events.
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

export class MirrorProjectDeletionReactor extends Context.Service<
  MirrorProjectDeletionReactor,
  MirrorProjectDeletionReactorShape
>()("t3/orchestration/Services/MirrorProjectDeletionReactor") {}

/**
 * NotificationReactor - Notification edge detection service interface.
 *
 * Owns the background worker that watches the post-commit domain event stream
 * and records every notification candidate edge into the notification outbox.
 *
 * Detection is unconditional: the reactor never consults a user setting and
 * never decides whether a notification is *shown*. That is transport policy.
 *
 * @module NotificationReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * NotificationReactorShape - Service API for notification reactor lifecycle.
 */
export interface NotificationReactorShape {
  /**
   * Start the notification reactor.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   *
   * Catches up from the durable cursor first, with the live stream already
   * buffered, so an event published during catch-up is neither lost nor applied
   * twice.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * NotificationReactor - Service tag for the notification edge detector.
 */
export class NotificationReactor extends Context.Service<
  NotificationReactor,
  NotificationReactorShape
>()("t3/orchestration/Services/NotificationReactor") {}

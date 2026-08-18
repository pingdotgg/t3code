/**
 * NotificationEdgeBus — the in-process hand-off from detection to transports.
 *
 * The `NotificationReactor` publishes every edge it decides was real; the
 * `notifications.subscribe` WS stream is the only consumer. It is deliberately
 * *not* durable: an edge published with nobody subscribed is dropped here and
 * stays `no-transport-connected` in the outbox, which is exactly the spec's
 * "no catch-up on launch" rule. The outbox — not this bus — is the audit record
 * and the while-you-were-away surface.
 *
 * @module NotificationEdgeBus
 */
import type { NotificationDecidedEdge } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export interface NotificationEdgeBusShape {
  readonly publish: (edge: NotificationDecidedEdge) => Effect.Effect<void>;
  /**
   * Attach one subscriber's feed. The subscription is live the moment this
   * effect completes and buffers into the caller's scope from then on, so a
   * subscriber can safely do slow work (the catch-up read) before it starts
   * pulling without losing an edge published in between.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<NotificationDecidedEdge>, never, Scope.Scope>;
}

export class NotificationEdgeBus extends Context.Service<
  NotificationEdgeBus,
  NotificationEdgeBusShape
>()("t3/orchestration/Services/NotificationEdgeBus") {}

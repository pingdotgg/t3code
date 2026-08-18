/**
 * NotificationEdgeBus layer.
 *
 * @module NotificationEdgeBus
 */
import type { NotificationDecidedEdge } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  NotificationEdgeBus,
  type NotificationEdgeBusShape,
} from "../Services/NotificationEdgeBus.ts";

export const makeNotificationEdgeBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<NotificationDecidedEdge>();

  return {
    publish: (edge) => PubSub.publish(pubSub, edge).pipe(Effect.asVoid),
    subscribe: PubSub.subscribe(pubSub).pipe(Effect.map(Stream.fromSubscription)),
  } satisfies NotificationEdgeBusShape;
});

export const NotificationEdgeBusLive = Layer.effect(NotificationEdgeBus, makeNotificationEdgeBus);

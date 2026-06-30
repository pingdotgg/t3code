import type { BoardTicketView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  WorkflowBoardEvents,
  type WorkflowBoardEventsShape,
} from "../Services/WorkflowBoardEvents.ts";

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<BoardTicketView>();

  const publish: WorkflowBoardEventsShape["publish"] = (ticket) =>
    PubSub.publish(pubsub, ticket).pipe(Effect.asVoid);
  const stream: WorkflowBoardEventsShape["stream"] = (boardId) =>
    Stream.fromPubSub(pubsub).pipe(Stream.filter((ticket) => ticket.boardId === boardId));
  // Subscribe synchronously in the calling fiber (the subscription is registered
  // with the PubSub the instant this returns), then expose it as a stream. A
  // snapshot read after awaiting this cannot lose a publish into the read→subscribe
  // gap that `Stream.fromPubSub` (lazy subscribe) leaves open.
  const subscribe: WorkflowBoardEventsShape["subscribe"] = (boardId) =>
    PubSub.subscribe(pubsub).pipe(
      Effect.map((subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((ticket) => ticket.boardId === boardId),
        ),
      ),
    );

  return { publish, stream, subscribe } satisfies WorkflowBoardEventsShape;
});

export const WorkflowBoardEventsLive = Layer.effect(WorkflowBoardEvents, make);

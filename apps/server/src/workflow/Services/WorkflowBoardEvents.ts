import type { BoardId, BoardTicketView } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export interface WorkflowBoardEventsShape {
  readonly publish: (ticket: BoardTicketView) => Effect.Effect<void>;
  readonly stream: (boardId: BoardId) => Stream.Stream<BoardTicketView>;
  /**
   * Eagerly acquire a PubSub subscription (scoped) and return a stream over it.
   * Unlike `stream`, the subscription is registered the instant this effect
   * returns — so a snapshot read performed AFTER awaiting this will not race a
   * concurrent publish into a gap. Pair with `Stream.unwrapScoped`.
   */
  readonly subscribe: (
    boardId: BoardId,
  ) => Effect.Effect<Stream.Stream<BoardTicketView>, never, Scope.Scope>;
}

export class WorkflowBoardEvents extends Context.Service<
  WorkflowBoardEvents,
  WorkflowBoardEventsShape
>()("t3/workflow/Services/WorkflowBoardEvents") {}

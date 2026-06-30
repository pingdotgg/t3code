import type { BoardId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

/**
 * Deletes the hidden orchestration threads created for workflow dispatches
 * (agent steps, review panels) when their owning ticket or board is deleted.
 * Thread ids must be collected BEFORE the workflow cascade removes the
 * outbox rows that know them; deletion runs after, through the real
 * thread.delete command path.
 */
export interface WorkflowThreadJanitorShape {
  readonly collectBoardThreads: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<string>, WorkflowEventStoreError>;
  readonly collectTicketThreads: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<string>, WorkflowEventStoreError>;
  readonly deleteThreads: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowThreadJanitor extends Context.Service<
  WorkflowThreadJanitor,
  WorkflowThreadJanitorShape
>()("t3/workflow/Services/WorkflowThreadJanitor") {}

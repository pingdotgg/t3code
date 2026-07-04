import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { BoardId, TicketId } from "../../../contracts/workflow.ts";
import type { WorkflowEventStoreError } from "./Errors.ts";

/**
 * Deletes the hidden orchestration threads created for workflow dispatches
 * when their owning ticket or board is deleted.
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
>()("@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowThreadJanitor") {}

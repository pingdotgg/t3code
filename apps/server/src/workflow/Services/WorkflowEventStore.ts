import type { BoardId, TicketId, WorkflowEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type PersistedWorkflowEvent = WorkflowEvent & { readonly sequence: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkflowEventInput = DistributiveOmit<WorkflowEvent, "streamVersion">;

export interface WorkflowEventStoreShape {
  readonly append: (
    event: WorkflowEventInput,
  ) => Effect.Effect<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly readByTicket: (
    ticketId: TicketId,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly readAll: () => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly deleteForBoard: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly deleteForTicket: (ticketId: TicketId) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowEventStore extends Context.Service<
  WorkflowEventStore,
  WorkflowEventStoreShape
>()("t3/workflow/Services/WorkflowEventStore") {}

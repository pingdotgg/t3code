import type { BoardId, LaneKey, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

/**
 * One stored per-agent session row: the stable workflow `threadId` minted for a
 * given `(ticketId, laneKey, agentKey)`. `getThreadId` reads only `threadId`;
 * `listByTicket`/`listByBoard` return enough to drive teardown (best-effort
 * `stopSession` per thread) before deleting.
 */
export interface WorkflowAgentSessionRow {
  readonly ticketId: TicketId;
  readonly laneKey: LaneKey;
  readonly agentKey: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface WorkflowAgentSessionStoreShape {
  /**
   * Record the stable `threadId` for `(ticketId, laneKey, agentKey)`. On
   * conflict it bumps `last_used_at` and PRESERVES the existing `thread_id`
   * (resume must keep reusing the same stable thread across steps/loops).
   */
  readonly upsert: (
    ticketId: TicketId,
    laneKey: LaneKey,
    agentKey: string,
    threadId: string,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  /** The stored thread id for the key, or `null` when none has been recorded. */
  readonly getThreadId: (
    ticketId: TicketId,
    laneKey: LaneKey,
    agentKey: string,
  ) => Effect.Effect<string | null, WorkflowEventStoreError>;
  readonly listByTicket: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<WorkflowAgentSessionRow>, WorkflowEventStoreError>;
  readonly deleteByTicket: (ticketId: TicketId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly listByBoard: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<WorkflowAgentSessionRow>, WorkflowEventStoreError>;
  readonly deleteByBoard: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowAgentSessionStore extends Context.Service<
  WorkflowAgentSessionStore,
  WorkflowAgentSessionStoreShape
>()("t3/workflow/Services/WorkflowAgentSessionStore") {}

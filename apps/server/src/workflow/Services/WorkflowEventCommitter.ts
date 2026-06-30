import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";
import type { PersistedWorkflowEvent, WorkflowEventInput } from "./WorkflowEventStore.ts";

export interface WorkflowEventCommitterShape {
  readonly commit: (event: WorkflowEventInput) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly commitMany: (
    events: ReadonlyArray<WorkflowEventInput>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // Lock-free append+project core. CALLER MUST already hold the board save lock
  // for every affected board AND be inside an open `sql.withTransaction`. Unlike
  // commit/commitMany this neither acquires the save lock nor opens a
  // transaction (it would deadlock the non-reentrant lock / nest the tx), and it
  // does NOT publish ticket views — the caller is responsible for the post-lock
  // recheck, publish, and pipeline starts. Used by batch syncers (Task 9) that
  // open one lock + one transaction per chunk and then call engine unlocked ops.
  readonly appendManyUnlocked: (
    events: ReadonlyArray<WorkflowEventInput>,
  ) => Effect.Effect<ReadonlyArray<PersistedWorkflowEvent>, WorkflowEventStoreError>;
  // Publish a live ticket view to WorkflowBoardEvents for a ticket id, mirroring
  // the post-lock publish commit/commitMany perform. Batch syncers that drive
  // appendManyUnlocked (which does NOT publish) call this AFTER releasing the
  // lock/tx so synced creates/edits/closes reach the live board stream.
  // `republishDependents` republishes the ticket's dependents too, matching
  // publishTicket's behavior on a terminal/lane move.
  readonly publishTicketView: (
    ticketId: PersistedWorkflowEvent["ticketId"],
    options?: { readonly republishDependents?: boolean },
  ) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowEventCommitter extends Context.Service<
  WorkflowEventCommitter,
  WorkflowEventCommitterShape
>()("t3/workflow/Services/WorkflowEventCommitter") {}

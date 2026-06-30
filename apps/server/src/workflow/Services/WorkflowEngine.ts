import type {
  BoardId,
  LaneKey,
  MessageId,
  StepRunId,
  ThreadId,
  TicketAttachment,
  TicketId,
  TurnId,
  WorkflowStepUsage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type RecoveredStepResult =
  | { readonly _tag: "completed"; readonly output?: unknown; readonly usage?: WorkflowStepUsage }
  | {
      readonly _tag: "failed";
      readonly error: string;
      readonly retryable?: boolean;
      readonly usage?: WorkflowStepUsage;
    }
  | { readonly _tag: "blocked"; readonly reason: string };

export interface WorkflowEngineShape {
  readonly createTicket: (input: {
    readonly boardId: BoardId;
    readonly title: string;
    readonly description?: string;
    readonly initialLane: LaneKey;
    readonly dependsOn?: ReadonlyArray<TicketId>;
    readonly tokenBudget?: number;
  }) => Effect.Effect<TicketId, WorkflowEventStoreError>;
  readonly editTicket: (input: {
    readonly ticketId: TicketId;
    readonly title?: string | undefined;
    readonly description?: string | undefined;
    readonly dependsOn?: ReadonlyArray<TicketId> | undefined;
    readonly tokenBudget?: number | null | undefined;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly moveTicket: (
    ticketId: TicketId,
    toLane: LaneKey,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // Committer-facing UNLOCKED ops for the work-source syncer (Task 9). The CALLER
  // MUST already hold the board save lock for the affected board AND be inside an
  // open `sql.withTransaction`; these never acquire the save lock, never open a
  // transaction, and never take the admission lock. Driving them is how a batch
  // syncer creates/closes/edits tickets under ONE lock + ONE transaction per
  // chunk without deadlocking the non-reentrant save lock.
  readonly createTicketAndEnterUnlocked: (input: {
    readonly boardId: BoardId;
    readonly title: string;
    readonly description?: string;
    readonly destinationLane: LaneKey;
  }) => Effect.Effect<
    { readonly ticketId: TicketId; readonly outcome: "moved" | "queued" | "none" },
    WorkflowEventStoreError
  >;
  readonly closeTicketFromSourceUnlocked: (
    ticketId: TicketId,
    closedLane: LaneKey,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // Inverse of closeTicketFromSourceUnlocked: route a source-closed ticket OUT of
  // its current (closed) lane back into `destinationLane` when the upstream item
  // is reopened. DB-only move via the external path (no provider IO in-tx). Like
  // the close, any auto-lane pipeline start is dropped here (single-transaction
  // reason) and the committer's post-commit recoverBoardWip sweep starts it.
  readonly reopenTicketFromSourceUnlocked: (
    ticketId: TicketId,
    destinationLane: LaneKey,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // Snapshot the ticket's cancellable provider turns (pending/started dispatch
  // outbox rows). The source committer captures this INSIDE the chunk tx, BEFORE
  // closeTicketFromSourceUnlocked tombstones those rows, then replays it through
  // supersedeProviderWorkForTicket AFTER the tx commits.
  readonly cancellableProviderTurnsForTicket: (
    ticketId: TicketId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly turnId: TurnId | null }>,
    WorkflowEventStoreError
  >;
  // POST-TX provider cancellation for a source-closed ticket: interrupt the
  // running pipeline fiber + cancel the captured provider turns. NO DB writes
  // (the in-tx close already tombstoned the outbox). Idempotent. The committer
  // calls this after the chunk transaction commits so no provider/fiber IO runs
  // inside the transaction.
  readonly supersedeProviderWorkForTicket: (
    ticketId: TicketId,
    turns: ReadonlyArray<{ readonly threadId: ThreadId; readonly turnId: TurnId | null }>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // Snapshot the ticket's stored per-agent session thread ids. The source
  // committer captures this INSIDE the chunk tx, BEFORE closeTicketFromSourceUnlocked
  // tears down (deletes) the rows on its terminal entry, then replays it through
  // stopAgentSessionsForTicket AFTER the tx commits. `provider.stopSession` is a
  // non-rollbackable live side effect (it kills the provider session + does its
  // own SQL write) so it must never run inside the chunk transaction.
  readonly terminalAgentSessionThreadsForTicket: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<string>, WorkflowEventStoreError>;
  // POST-TX best-effort live stop of the agent-session threads snapshotted by
  // terminalAgentSessionThreadsForTicket. The in-tx teardown already deleted the
  // rows; this only fires provider.stopSession after the chunk transaction commits.
  readonly stopAgentSessionsForTicket: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly editTicketFieldsUnlocked: (
    ticketId: TicketId,
    fields: { readonly title?: string | undefined; readonly description?: string | undefined },
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // Acquire the per-board admission semaphore (the WIP read-decide serializer).
  // The source committer MUST wrap its chunk in this (OUTER) -> the board save
  // lock (INNER) -> the transaction, matching the public enterLane lock order
  // (admission->save), so sync admits serialize against concurrent user moves
  // and cannot violate a WIP limit. The unlocked enterLane cores assume this is
  // already held.
  readonly withBoardAdmissionLock: <A, E, R>(
    boardId: BoardId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly runLane: (ticketId: TicketId) => Effect.Effect<void, WorkflowEventStoreError>;
  // Webhook-correlated event: evaluates the ticket's current lane onEvent
  // matchers and moves/queues the ticket like a manual move when one fires.
  readonly ingestExternalEvent: (input: {
    readonly boardId: BoardId;
    readonly name: string;
    readonly ticketId: TicketId;
    readonly payload: unknown;
  }) => Effect.Effect<
    { readonly outcome: "moved" | "queued" | "noop"; readonly toLane?: string },
    WorkflowEventStoreError
  >;
  readonly resolveApproval: (
    stepRunId: StepRunId,
    approved: boolean,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly answerTicketStep: (input: {
    readonly stepRunId: StepRunId;
    readonly text?: string | undefined;
    readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly postTicketMessage: (input: {
    readonly ticketId: TicketId;
    readonly text?: string | undefined;
    readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly editTicketMessage: (input: {
    readonly ticketId: TicketId;
    readonly messageId: MessageId;
    readonly body: string;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly cancelStep: (stepRunId: StepRunId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly cancelBoardPipelines: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly cancelTicketPipelines: (
    ticketId: TicketId,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly recoverBoardWip: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly completeRecoveredStep: (
    stepRunId: StepRunId,
    result: RecoveredStepResult,
    captureTurn?: { readonly threadId: ThreadId; readonly turnId: TurnId },
  ) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()(
  "t3/workflow/Services/WorkflowEngine",
) {}

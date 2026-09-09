/**
 * ProjectionTurnRepository - Projection repository interface for unified turn state.
 *
 * Owns persistence operations for pending starts, running/completed turn lifecycle,
 * and checkpoint metadata in a single projection table.
 *
 * @module ProjectionTurnRepository
 */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnState = Schema.Literals([
  "pending",
  "submitted",
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type ProjectionTurnState = typeof ProjectionTurnState.Type;

export const ProjectionTurn = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  submittedTurnId: Schema.NullOr(TurnId),
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
  checkpointFiles: Schema.Array(OrchestrationCheckpointFile),
});
export type ProjectionTurn = typeof ProjectionTurn.Type;

export const ProjectionTurnById = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
  checkpointFiles: Schema.Array(OrchestrationCheckpointFile),
});
export type ProjectionTurnById = typeof ProjectionTurnById.Type;

export const ProjectionPendingTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
});
export type ProjectionPendingTurnStart = typeof ProjectionPendingTurnStart.Type;

export const ProjectionSubmittedTurnStart = Schema.Struct({
  ...ProjectionPendingTurnStart.fields,
  turnId: TurnId,
});
export type ProjectionSubmittedTurnStart = typeof ProjectionSubmittedTurnStart.Type;

export const ListProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionTurnsByThreadInput = typeof ListProjectionTurnsByThreadInput.Type;

export const GetProjectionTurnByTurnIdInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetProjectionTurnByTurnIdInput = typeof GetProjectionTurnByTurnIdInput.Type;

export const GetProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionPendingTurnStartInput = typeof GetProjectionPendingTurnStartInput.Type;

export const GetProjectionAdoptableTurnStartInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetProjectionAdoptableTurnStartInput = typeof GetProjectionAdoptableTurnStartInput.Type;

export const GetProjectionSubmittedTurnStartInput = GetProjectionAdoptableTurnStartInput;
export type GetProjectionSubmittedTurnStartInput = typeof GetProjectionSubmittedTurnStartInput.Type;

export const DeleteProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type DeleteProjectionPendingTurnStartInput =
  typeof DeleteProjectionPendingTurnStartInput.Type;

export const AcknowledgeProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: TurnId,
});
export type AcknowledgeProjectionPendingTurnStartInput =
  typeof AcknowledgeProjectionPendingTurnStartInput.Type;

export const DeleteProjectionSubmittedTurnStartsInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type DeleteProjectionSubmittedTurnStartsInput =
  typeof DeleteProjectionSubmittedTurnStartsInput.Type;

export const DeleteProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionTurnsByThreadInput = typeof DeleteProjectionTurnsByThreadInput.Type;

export const DeleteProjectionTurnsAfterCheckpointInput = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});
export type DeleteProjectionTurnsAfterCheckpointInput =
  typeof DeleteProjectionTurnsAfterCheckpointInput.Type;

export const ClearCheckpointTurnConflictInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
});
export type ClearCheckpointTurnConflictInput = typeof ClearCheckpointTurnConflictInput.Type;

export interface ProjectionTurnRepositoryShape {
  /**
   * Inserts or updates the canonical row for a concrete `{threadId, turnId}` turn lifecycle state.
   */
  readonly upsertByTurnId: (
    row: ProjectionTurnById,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Inserts one pending-start placeholder. Multiple accepted starts may wait
   * behind serialized checkpoint work and must remain independently durable.
   */
  readonly insertPendingTurnStart: (
    row: ProjectionPendingTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Restores an accepted placeholder without making it eligible for startup resubmission. */
  readonly insertSubmittedTurnStart: (
    row: ProjectionSubmittedTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Marks one correlated start as accepted by the provider so startup does not replay it. */
  readonly markPendingTurnStartSubmitted: (
    input: AcknowledgeProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Clears accepted steering placeholders correlated to a provider turn after it settles. */
  readonly deleteSubmittedTurnStartsByTurnId: (
    input: DeleteProjectionSubmittedTurnStartsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Returns the oldest start that has not yet been accepted by a provider.
   * Startup reconciliation uses this to exclude acknowledged submissions.
   */
  readonly getPendingTurnStartByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /** Returns the oldest pending start or acknowledgement belonging to this provider turn. */
  readonly getAdoptableTurnStartByThreadId: (
    input: GetProjectionAdoptableTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /** Returns only the accepted start correlated to this provider turn. */
  readonly getSubmittedTurnStartByTurnId: (
    input: GetProjectionSubmittedTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /**
   * Deletes one correlated pending-start placeholder and leaves other queued
   * starts and concrete turn rows untouched.
   */
  readonly deletePendingTurnStart: (
    input: DeleteProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Deletes concrete turns beyond a revert boundary without disturbing queued start order. */
  readonly deleteTurnsAfterCheckpoint: (
    input: DeleteProjectionTurnsAfterCheckpointInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Lists all projection rows for a thread, including pending placeholders, with checkpoint rows ordered before non-checkpoint rows.
   */
  readonly listByThreadId: (
    input: ListProjectionTurnsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, ProjectionRepositoryError>;

  /**
   * Looks up a concrete turn row by `{threadId, turnId}` and never returns pending placeholder rows.
   */
  readonly getByTurnId: (
    input: GetProjectionTurnByTurnIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnById>, ProjectionRepositoryError>;

  /**
   * Clears checkpoint fields on conflicting rows that reuse the same checkpoint turn count in a thread, excluding the provided turn.
   */
  readonly clearCheckpointTurnConflict: (
    input: ClearCheckpointTurnConflictInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Hard-deletes all projection rows for a thread, including pending-start placeholders and checkpoint metadata rows.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionTurnsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnRepository extends Context.Service<
  ProjectionTurnRepository,
  ProjectionTurnRepositoryShape
>()("t3/persistence/Services/ProjectionTurns/ProjectionTurnRepository") {}

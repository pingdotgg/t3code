/**
 * ProjectionThreadQueuedTurnRepository - Projection repository interface for queued turns.
 *
 * Owns persistence operations for user messages that have been queued while
 * a provider turn is still running and have not yet been promoted to a real
 * turn start.
 *
 * @module ProjectionThreadQueuedTurnRepository
 */
import {
  IsoDateTime,
  MessageId,
  OrchestrationProposedPlanId,
  OrchestrationQueuedTurn,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadQueuedTurn = OrchestrationQueuedTurn;
export type ProjectionThreadQueuedTurn = typeof ProjectionThreadQueuedTurn.Type;

export const UpsertProjectionThreadQueuedTurnInput = ProjectionThreadQueuedTurn;
export type UpsertProjectionThreadQueuedTurnInput =
  typeof UpsertProjectionThreadQueuedTurnInput.Type;

export const GetProjectionThreadQueuedTurnInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadQueuedTurnInput = typeof GetProjectionThreadQueuedTurnInput.Type;

export const GetProjectionThreadQueuedTurnByMessageIdInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadQueuedTurnByMessageIdInput =
  typeof GetProjectionThreadQueuedTurnByMessageIdInput.Type;

export const ListProjectionThreadQueuedTurnsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadQueuedTurnsInput = typeof ListProjectionThreadQueuedTurnsInput.Type;

export const DeleteProjectionThreadQueuedTurnsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadQueuedTurnsInput =
  typeof DeleteProjectionThreadQueuedTurnsInput.Type;

export const ProjectionThreadQueuedTurnDbRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: Schema.Literal("user"),
  text: Schema.String,
  attachments: Schema.String,
  modelSelection: Schema.NullOr(Schema.String),
  titleSeed: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadQueuedTurnDbRow = typeof ProjectionThreadQueuedTurnDbRow.Type;

export interface ProjectionThreadQueuedTurnRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadQueuedTurn,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByMessageId: (
    input: GetProjectionThreadQueuedTurnByMessageIdInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedTurn>, ProjectionRepositoryError>;

  readonly getByThreadAndMessageId: (
    input: GetProjectionThreadQueuedTurnInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedTurn>, ProjectionRepositoryError>;

  readonly getOldestByThreadId: (
    input: ListProjectionThreadQueuedTurnsInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedTurn>, ProjectionRepositoryError>;

  readonly listByThreadId: (
    input: ListProjectionThreadQueuedTurnsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadQueuedTurn>, ProjectionRepositoryError>;

  readonly listThreadIdsWithQueuedTurns: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;

  readonly deleteByMessageId: (
    input: GetProjectionThreadQueuedTurnByMessageIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteProjectionThreadQueuedTurnsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadQueuedTurnRepository extends Context.Service<
  ProjectionThreadQueuedTurnRepository,
  ProjectionThreadQueuedTurnRepositoryShape
>()(
  "salchi/persistence/Services/ProjectionThreadQueuedTurns/ProjectionThreadQueuedTurnRepository",
) {}

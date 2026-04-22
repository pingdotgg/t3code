import {
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@harness/contracts";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadTurnQueueRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachmentIds: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  titleSeed: Schema.NullOr(Schema.String),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  queuedAt: IsoDateTime,
  enqueueSequence: NonNegativeInt,
});
export type ProjectionThreadTurnQueueRow = typeof ProjectionThreadTurnQueueRow.Type;

export const ListProjectionThreadTurnQueueByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadTurnQueueByThreadInput =
  typeof ListProjectionThreadTurnQueueByThreadInput.Type;

export const GetProjectionThreadTurnQueueItemInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadTurnQueueItemInput =
  typeof GetProjectionThreadTurnQueueItemInput.Type;

export const DeleteProjectionThreadTurnQueueItemInput = GetProjectionThreadTurnQueueItemInput;
export type DeleteProjectionThreadTurnQueueItemInput =
  typeof DeleteProjectionThreadTurnQueueItemInput.Type;

export const DeleteProjectionThreadTurnQueueByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadTurnQueueByThreadInput =
  typeof DeleteProjectionThreadTurnQueueByThreadInput.Type;

export interface ProjectionThreadTurnQueueRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadTurnQueueRow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadTurnQueueItemInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadTurnQueueRow>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadTurnQueueByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadTurnQueueRow>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionThreadTurnQueueItemInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadTurnQueueByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadTurnQueueRepository extends Context.Service<
  ProjectionThreadTurnQueueRepository,
  ProjectionThreadTurnQueueRepositoryShape
>()("harness/persistence/Services/ProjectionThreadTurnQueue/ProjectionThreadTurnQueueRepository") {}

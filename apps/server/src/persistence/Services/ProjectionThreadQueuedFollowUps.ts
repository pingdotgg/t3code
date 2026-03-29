import {
  IsoDateTime,
  ModelSelection,
  OrchestrationQueuedFollowUp,
  OrchestrationQueuedTerminalContext,
  RuntimeMode,
  ProviderInteractionMode,
  ThreadId,
  TrimmedNonEmptyString,
  NonNegativeInt,
  ChatAttachment,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadQueuedFollowUp = Schema.Struct({
  followUpId: TrimmedNonEmptyString,
  threadId: ThreadId,
  queuePosition: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  prompt: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  terminalContexts: Schema.Array(OrchestrationQueuedTerminalContext),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  lastSendError: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectionThreadQueuedFollowUp = typeof ProjectionThreadQueuedFollowUp.Type;

export const ListProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadQueuedFollowUpsInput =
  typeof ListProjectionThreadQueuedFollowUpsInput.Type;

export const GetProjectionThreadQueuedFollowUpInput = Schema.Struct({
  followUpId: TrimmedNonEmptyString,
});
export type GetProjectionThreadQueuedFollowUpInput =
  typeof GetProjectionThreadQueuedFollowUpInput.Type;

export const ReplaceProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
  followUps: Schema.Array(ProjectionThreadQueuedFollowUp),
});
export type ReplaceProjectionThreadQueuedFollowUpsInput =
  typeof ReplaceProjectionThreadQueuedFollowUpsInput.Type;

export const DeleteProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadQueuedFollowUpsInput =
  typeof DeleteProjectionThreadQueuedFollowUpsInput.Type;

export function projectionQueuedFollowUpToContract(
  row: ProjectionThreadQueuedFollowUp,
): OrchestrationQueuedFollowUp {
  return {
    id: row.followUpId,
    createdAt: row.createdAt,
    prompt: row.prompt,
    attachments: row.attachments,
    terminalContexts: row.terminalContexts,
    modelSelection: row.modelSelection,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    lastSendError: row.lastSendError,
  };
}

export interface ProjectionThreadQueuedFollowUpRepositoryShape {
  readonly listByThreadId: (
    input: ListProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadQueuedFollowUp>, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadQueuedFollowUpInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedFollowUp>, ProjectionRepositoryError>;
  readonly replaceByThreadId: (
    input: ReplaceProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadQueuedFollowUpRepository extends ServiceMap.Service<
  ProjectionThreadQueuedFollowUpRepository,
  ProjectionThreadQueuedFollowUpRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadQueuedFollowUps/ProjectionThreadQueuedFollowUpRepository",
) {}

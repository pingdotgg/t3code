import { IsoDateTime, MessageId, ThreadId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPendingTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
export type ProjectionPendingTurnStart = typeof ProjectionPendingTurnStart.Type;

export const GetProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionPendingTurnStartInput = typeof GetProjectionPendingTurnStartInput.Type;

export const DeleteProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionPendingTurnStartInput = typeof DeleteProjectionPendingTurnStartInput.Type;

export interface ProjectionPendingTurnStartRepositoryShape {
  readonly upsert: (
    row: ProjectionPendingTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionPendingTurnStartRepository extends ServiceMap.Service<
  ProjectionPendingTurnStartRepository,
  ProjectionPendingTurnStartRepositoryShape
>()("persistence/ProjectionPendingTurnStartRepository") {}

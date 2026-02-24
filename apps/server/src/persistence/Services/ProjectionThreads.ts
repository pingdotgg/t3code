import { IsoDateTime, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  model: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

export interface ProjectionThreadRepositoryShape {
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadRepository extends ServiceMap.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("persistence/ProjectionThreadRepository") {}

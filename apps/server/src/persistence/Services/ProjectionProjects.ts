import { IsoDateTime, ProjectId, ProjectScript } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModel: Schema.NullOr(Schema.String),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProject = typeof ProjectionProject.Type;

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type;

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type;

export interface ProjectionProjectRepositoryShape {
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>;

  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProject>,
    ProjectionRepositoryError
  >;

  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionProjectRepository extends ServiceMap.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()("persistence/ProjectionProjectRepository") {}

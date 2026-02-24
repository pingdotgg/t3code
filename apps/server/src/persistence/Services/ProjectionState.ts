import { IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionState = Schema.Struct({
  projector: Schema.String,
  lastAppliedSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectionState = typeof ProjectionState.Type;

export const GetProjectionStateInput = Schema.Struct({
  projector: Schema.String,
});
export type GetProjectionStateInput = typeof GetProjectionStateInput.Type;

export interface ProjectionStateRepositoryShape {
  readonly upsert: (row: ProjectionState) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByProjector: (
    input: GetProjectionStateInput,
  ) => Effect.Effect<Option.Option<ProjectionState>, ProjectionRepositoryError>;

  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionState>, ProjectionRepositoryError>;

  readonly minLastAppliedSequence: () => Effect.Effect<number | null, ProjectionRepositoryError>;
}

export class ProjectionStateRepository extends ServiceMap.Service<
  ProjectionStateRepository,
  ProjectionStateRepositoryShape
>()("persistence/ProjectionStateRepository") {}

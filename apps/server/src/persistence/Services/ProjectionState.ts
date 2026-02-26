/**
 * ProjectionStateRepository - Projection repository interface for projector cursors.
 *
 * Owns persistence operations for projection cursor state used to resume
 * incremental event projection.
 *
 * @module ProjectionStateRepository
 */
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

/**
 * ProjectionStateRepositoryShape - Service API for projector state records.
 */
export interface ProjectionStateRepositoryShape {
  /**
   * Insert or replace a projection cursor row.
   *
   * Upserts by projector name.
   */
  readonly upsert: (row: ProjectionState) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projection cursor state for a projector key.
   */
  readonly getByProjector: (
    input: GetProjectionStateInput,
  ) => Effect.Effect<Option.Option<ProjectionState>, ProjectionRepositoryError>;

  /**
   * List all projector cursor rows.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionState>, ProjectionRepositoryError>;

  /**
   * Read the minimum applied sequence across all projectors.
   *
   * Returns `null` when no projector state rows exist.
   */
  readonly minLastAppliedSequence: () => Effect.Effect<number | null, ProjectionRepositoryError>;
}

/**
 * ProjectionStateRepository - Service tag for projection cursor persistence.
 */
export class ProjectionStateRepository extends ServiceMap.Service<
  ProjectionStateRepository,
  ProjectionStateRepositoryShape
>()("persistence/ProjectionStateRepository") {}

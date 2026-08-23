/**
 * ProjectionTaskRepository - Repository interface for scheduled tasks.
 *
 * Owns persistence operations for projected task records in the orchestration
 * read model.
 *
 * @module ProjectionTaskRepository
 */
import { IsoDateTime, ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTask = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  threadId: ThreadId,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.String,
  scheduleJson: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastFiredAt: Schema.NullOr(IsoDateTime),
  nextFireAt: Schema.NullOr(IsoDateTime),
  cancelledAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTask = typeof ProjectionTask.Type;

export const GetProjectionTaskInput = Schema.Struct({
  taskId: TaskId,
});
export type GetProjectionTaskInput = typeof GetProjectionTaskInput.Type;

export const DeleteProjectionTaskInput = Schema.Struct({
  taskId: TaskId,
});
export type DeleteProjectionTaskInput = typeof DeleteProjectionTaskInput.Type;

export const ListProjectionTasksByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionTasksByProjectInput = typeof ListProjectionTasksByProjectInput.Type;

/**
 * ProjectionTaskRepositoryShape - Service API for projected task records.
 */
export interface ProjectionTaskRepositoryShape {
  /**
   * Insert or replace a projected task row.
   *
   * Upserts by `taskId`.
   */
  readonly upsert: (task: ProjectionTask) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected task row by id.
   */
  readonly getById: (
    input: GetProjectionTaskInput,
  ) => Effect.Effect<Option.Option<ProjectionTask>, ProjectionRepositoryError>;

  /**
   * List projected tasks for a project.
   */
  readonly listByProjectId: (
    input: ListProjectionTasksByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTask>, ProjectionRepositoryError>;

  /**
   * Delete projected task state by id.
   */
  readonly deleteById: (
    input: DeleteProjectionTaskInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionTaskRepository - Service tag for task persistence.
 */
export class ProjectionTaskRepository extends Context.Service<
  ProjectionTaskRepository,
  ProjectionTaskRepositoryShape
>()("t3/persistence/Services/ProjectionTasks/ProjectionTaskRepository") {}

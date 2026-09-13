import { IsoDateTime, ProjectId, TaskId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTask = Schema.Struct({
  taskId: TaskId,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  primaryProjectId: ProjectId,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  unsettledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  pinOrderKey: Schema.NullOr(TrimmedNonEmptyString),
  activeOrderKey: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTask = typeof ProjectionTask.Type;

export const GetProjectionTaskInput = Schema.Struct({ taskId: TaskId });
export type GetProjectionTaskInput = typeof GetProjectionTaskInput.Type;

export const DeleteProjectionTaskInput = Schema.Struct({ taskId: TaskId });
export type DeleteProjectionTaskInput = typeof DeleteProjectionTaskInput.Type;

export interface ProjectionTaskRepositoryShape {
  /** Upsert the complete projected record, including any lifecycle tombstone. */
  readonly upsert: (task: ProjectionTask) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionTaskInput,
  ) => Effect.Effect<Option.Option<ProjectionTask>, ProjectionRepositoryError>;
  /** List all records, including tombstones, in deterministic creation order. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionTask>, ProjectionRepositoryError>;
  /** Physically remove a projection during reset/rebuild; lifecycle deletion uses upsert. */
  readonly deleteById: (
    input: DeleteProjectionTaskInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTaskRepository extends Context.Service<
  ProjectionTaskRepository,
  ProjectionTaskRepositoryShape
>()("t3/persistence/Services/ProjectionTasks/ProjectionTaskRepository") {}

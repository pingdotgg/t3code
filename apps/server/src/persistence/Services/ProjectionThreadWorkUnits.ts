import {
  EventId,
  IsoDateTime,
  OrchestrationWorkUnitKind,
  OrchestrationWorkUnitProviderRefs,
  OrchestrationWorkUnitState,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
  WorkUnitId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadWorkUnit = Schema.Struct({
  workUnitId: WorkUnitId,
  threadId: ThreadId,
  turnId: TurnId,
  parentWorkUnitId: Schema.NullOr(WorkUnitId),
  kind: OrchestrationWorkUnitKind,
  state: OrchestrationWorkUnitState,
  title: TrimmedNonEmptyString,
  detail: Schema.NullOr(TrimmedNonEmptyString),
  spawnedByActivityId: Schema.NullOr(EventId),
  providerRefs: Schema.optional(OrchestrationWorkUnitProviderRefs),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThreadWorkUnit = typeof ProjectionThreadWorkUnit.Type;

export const ListProjectionThreadWorkUnitsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadWorkUnitsInput = typeof ListProjectionThreadWorkUnitsInput.Type;

export const DeleteProjectionThreadWorkUnitsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadWorkUnitsInput = typeof DeleteProjectionThreadWorkUnitsInput.Type;

export interface ProjectionThreadWorkUnitRepositoryShape {
  readonly upsert: (
    workUnit: ProjectionThreadWorkUnit,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadWorkUnitsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadWorkUnit>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadWorkUnitsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadWorkUnitRepository extends ServiceMap.Service<
  ProjectionThreadWorkUnitRepository,
  ProjectionThreadWorkUnitRepositoryShape
>()("t3/persistence/Services/ProjectionThreadWorkUnits/ProjectionThreadWorkUnitRepository") {}

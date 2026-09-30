import {
  IsoDateTime,
  OrchestrationProposedPlanId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadProposedPlan = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlan = typeof ProjectionThreadProposedPlan.Type;

export const ListProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadProposedPlansInput =
  typeof ListProjectionThreadProposedPlansInput.Type;

export const HasActionableProjectionThreadProposedPlanInput = Schema.Struct({
  threadId: ThreadId,
  latestTurnId: Schema.NullOr(TurnId),
});
export type HasActionableProjectionThreadProposedPlanInput =
  typeof HasActionableProjectionThreadProposedPlanInput.Type;

export const GetProjectionThreadProposedPlanInput = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
export type GetProjectionThreadProposedPlanInput = typeof GetProjectionThreadProposedPlanInput.Type;

export const DeleteProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadProposedPlansInput =
  typeof DeleteProjectionThreadProposedPlansInput.Type;

export interface ProjectionThreadProposedPlanRepositoryShape {
  readonly upsert: (
    proposedPlan: ProjectionThreadProposedPlan,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Read one plan without loading the thread's other plans. */
  readonly getByPlanId: (
    input: GetProjectionThreadProposedPlanInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadProposedPlan>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadProposedPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadProposedPlan>, ProjectionRepositoryError>;
  readonly hasActionableByThreadId: (
    input: HasActionableProjectionThreadProposedPlanInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadProposedPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadProposedPlanRepository extends Context.Service<
  ProjectionThreadProposedPlanRepository,
  ProjectionThreadProposedPlanRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadProposedPlans/ProjectionThreadProposedPlanRepository",
) {}

import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUsageBucket,
  ProviderUsageSummary,
  ProviderUsageSummaryInput,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnUsage = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  usage: ThreadTokenUsageSnapshot,
  updatedAt: IsoDateTime,
});
export type ProjectionTurnUsage = typeof ProjectionTurnUsage.Type;

export const ListProjectionTurnUsageByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionTurnUsageByThreadInput = typeof ListProjectionTurnUsageByThreadInput.Type;

export const DeleteProjectionTurnUsageByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionTurnUsageByThreadInput =
  typeof DeleteProjectionTurnUsageByThreadInput.Type;

export const ProjectionUsageSummaryInput = ProviderUsageSummaryInput;
export type ProjectionUsageSummaryInput = ProviderUsageSummaryInput;

export const ProjectionUsageBucket = ProviderUsageBucket;
export type ProjectionUsageBucket = ProviderUsageBucket;

export const ProjectionUsageSummary = ProviderUsageSummary;
export type ProjectionUsageSummary = ProviderUsageSummary;

export interface ProjectionTurnUsageRepositoryShape {
  readonly upsert: (row: ProjectionTurnUsage) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionTurnUsageByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurnUsage>, ProjectionRepositoryError>;
  readonly summarize: (
    input: ProjectionUsageSummaryInput,
  ) => Effect.Effect<ProjectionUsageSummary, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionTurnUsageByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnUsageRepository extends Context.Service<
  ProjectionTurnUsageRepository,
  ProjectionTurnUsageRepositoryShape
>()("t3/persistence/Services/ProjectionTurnUsage/ProjectionTurnUsageRepository") {}

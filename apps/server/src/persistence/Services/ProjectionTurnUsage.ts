import {
  IsoDateTime,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
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

export const ProjectionUsageSummaryInput = Schema.Struct({
  since: IsoDateTime,
  until: Schema.optional(IsoDateTime),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: Schema.optional(ThreadId),
});
export type ProjectionUsageSummaryInput = typeof ProjectionUsageSummaryInput.Type;

export const ProjectionUsageBucket = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  turns: NonNegativeInt,
  usage: ThreadTokenUsageSnapshot,
  totalCostUsd: Schema.NullOr(Schema.Number),
  costIsPartial: Schema.Boolean,
});
export type ProjectionUsageBucket = typeof ProjectionUsageBucket.Type;

export const ProjectionUsageSummary = Schema.Struct({
  totalTurns: NonNegativeInt,
  totalInputTokens: NonNegativeInt,
  totalUncachedInputTokens: NonNegativeInt,
  totalCachedInputTokens: NonNegativeInt,
  totalCacheCreationInputTokens: NonNegativeInt,
  totalCacheReadInputTokens: NonNegativeInt,
  totalOutputTokens: NonNegativeInt,
  totalReasoningOutputTokens: NonNegativeInt,
  totalProcessedTokens: NonNegativeInt,
  totalCostUsd: Schema.NullOr(Schema.Number),
  costIsPartial: Schema.Boolean,
  byProvider: Schema.Array(ProjectionUsageBucket),
  byModel: Schema.Array(ProjectionUsageBucket),
});
export type ProjectionUsageSummary = typeof ProjectionUsageSummary.Type;

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

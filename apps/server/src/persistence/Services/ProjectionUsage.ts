import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  UsageFactId,
  UsageFactKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionUsageFact = Schema.Struct({
  factId: UsageFactId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  projectId: Schema.NullOr(ProjectId),
  provider: ProviderDriverKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerSessionId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelRaw: TrimmedNonEmptyString,
  reasoningEffort: Schema.NullOr(TrimmedNonEmptyString),
  kind: UsageFactKind,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  costMicroUsd: Schema.NullOr(NonNegativeInt),
  stale: Schema.Boolean,
  observedAt: IsoDateTime,
});
export type ProjectionUsageFact = typeof ProjectionUsageFact.Type;

export const RedactProjectionUsageThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type RedactProjectionUsageThreadInput = typeof RedactProjectionUsageThreadInput.Type;

export const ListProjectionUsageFactsInput = Schema.Struct({
  sinceIso: Schema.optional(IsoDateTime),
  untilIso: Schema.optional(IsoDateTime),
});
export type ListProjectionUsageFactsInput = typeof ListProjectionUsageFactsInput.Type;

/** Per-model sums of everything already recorded for one provider-native
 * session. Used as the durable baseline when converting a provider's
 * cumulative counters into interval facts — after a restart the in-memory
 * baseline is gone, and resuming from recorded sums prevents double counting. */
export const ProjectionUsageSessionModelSum = Schema.Struct({
  model: TrimmedNonEmptyString,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  costMicroUsd: NonNegativeInt,
});
export type ProjectionUsageSessionModelSum = typeof ProjectionUsageSessionModelSum.Type;

export interface ProjectionUsageRepositoryShape {
  readonly upsertFact: (row: ProjectionUsageFact) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly redactThread: (
    input: RedactProjectionUsageThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly listFacts: (
    input: ListProjectionUsageFactsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionUsageFact>, ProjectionRepositoryError>;

  readonly earliestObservedAt: () => Effect.Effect<string | null, ProjectionRepositoryError>;

  readonly sumBySessionModel: (input: {
    readonly providerSessionId: string;
  }) => Effect.Effect<ReadonlyArray<ProjectionUsageSessionModelSum>, ProjectionRepositoryError>;
}

export class ProjectionUsageRepository extends Context.Service<
  ProjectionUsageRepository,
  ProjectionUsageRepositoryShape
>()("t3/persistence/Services/ProjectionUsage/ProjectionUsageRepository") {}

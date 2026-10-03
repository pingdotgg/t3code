import {
  CollaborativeAcceptanceAssessment,
  CollaborativeAcceptanceCase,
  CollaborativeAcceptanceCandidate,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceEvidence,
  CollaborativeAcceptanceExchange,
  CollaborativeAcceptanceObligation,
  CollaborativeAcceptanceProviderEvidence,
  CollaborativeAcceptanceProjection,
  CollaborativeAcceptanceRecord,
  type PullRequestRef,
} from "@t3tools/contracts";
import { Context, Effect, Option, Schema } from "effect";

import type { CollaborativeAcceptanceRepositoryError } from "../Errors.ts";

export interface CollaborativeAcceptanceRepositoryShape {
  readonly save: (input: {
    readonly record: CollaborativeAcceptanceRecord;
    /**
     * `null` is only valid for the first write. Every later write must carry the
     * revision read in the same aggregate snapshot that produced the record.
     */
    readonly expectedRevision: number | null;
  }) => Effect.Effect<CollaborativeAcceptanceRecord, CollaborativeAcceptanceRepositoryError>;
  readonly getByCaseId: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
  }) => Effect.Effect<
    Option.Option<CollaborativeAcceptanceRecord>,
    CollaborativeAcceptanceRepositoryError
  >;
  readonly listByAssignmentId: (input: {
    readonly assignmentId: string;
  }) => Effect.Effect<
    ReadonlyArray<CollaborativeAcceptanceRecord>,
    CollaborativeAcceptanceRepositoryError
  >;
  readonly listByParentThreadId: (input: {
    readonly parentThreadId: string;
  }) => Effect.Effect<
    ReadonlyArray<CollaborativeAcceptanceRecord>,
    CollaborativeAcceptanceRepositoryError
  >;
  readonly listByPullRequest: (
    input: PullRequestRef,
  ) => Effect.Effect<
    ReadonlyArray<CollaborativeAcceptanceRecord>,
    CollaborativeAcceptanceRepositoryError
  >;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<CollaborativeAcceptanceRecord>,
    CollaborativeAcceptanceRepositoryError
  >;
}

export class CollaborativeAcceptanceRepository extends Context.Service<
  CollaborativeAcceptanceRepository,
  CollaborativeAcceptanceRepositoryShape
>()("t3/persistence/Services/CollaborativeAcceptance/Repository") {}

export const CollaborativeAcceptanceCaseDbRow = Schema.Struct({
  revision: Schema.Number,
  case: Schema.fromJsonString(CollaborativeAcceptanceCase),
  projection: Schema.fromJsonString(CollaborativeAcceptanceProjection),
  providerEvidence: Schema.NullOr(Schema.fromJsonString(CollaborativeAcceptanceProviderEvidence)),
  obligations: Schema.fromJsonString(Schema.Array(CollaborativeAcceptanceObligation)),
});
export type CollaborativeAcceptanceCaseDbRow = typeof CollaborativeAcceptanceCaseDbRow.Type;

export const CollaborativeAcceptanceCandidateDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceCandidate,
);
export const CollaborativeAcceptanceEvidenceDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceEvidence,
);
export const CollaborativeAcceptanceAssessmentDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceAssessment,
);
export const CollaborativeAcceptanceExchangeDbRow = Schema.fromJsonString(
  CollaborativeAcceptanceExchange,
);

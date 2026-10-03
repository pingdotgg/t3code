import * as Schema from "effect/Schema";

import {
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestRef,
  PullRequestState,
} from "./pullRequest.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const AcceptanceId = (brand: string) => TrimmedNonEmptyString.pipe(Schema.brand(brand));

/** Canonical aggregate identity owned by Collaborative Acceptance. */
export const CollaborativeAcceptanceCaseId = AcceptanceId("CollaborativeAcceptanceCaseId");
export type CollaborativeAcceptanceCaseId = typeof CollaborativeAcceptanceCaseId.Type;

/** Canonical immutable review-candidate identity owned by Collaborative Acceptance. */
export const CollaborativeAcceptanceCandidateId = AcceptanceId(
  "CollaborativeAcceptanceCandidateId",
);
export type CollaborativeAcceptanceCandidateId = typeof CollaborativeAcceptanceCandidateId.Type;

export const CollaborativeAcceptanceEvidenceId = AcceptanceId("CollaborativeAcceptanceEvidenceId");
export type CollaborativeAcceptanceEvidenceId = typeof CollaborativeAcceptanceEvidenceId.Type;

export const CollaborativeAcceptanceAssessmentId = AcceptanceId(
  "CollaborativeAcceptanceAssessmentId",
);
export type CollaborativeAcceptanceAssessmentId = typeof CollaborativeAcceptanceAssessmentId.Type;

/**
 * Canonical request-exchange identity. Later request-transport modules must reference this
 * identity instead of defining a second exchange lifecycle.
 */
export const CollaborativeAcceptanceExchangeId = AcceptanceId("CollaborativeAcceptanceExchangeId");
export type CollaborativeAcceptanceExchangeId = typeof CollaborativeAcceptanceExchangeId.Type;

export const CollaborativeAcceptanceExecutionId = AcceptanceId(
  "CollaborativeAcceptanceExecutionId",
);
export type CollaborativeAcceptanceExecutionId = typeof CollaborativeAcceptanceExecutionId.Type;

export const CollaborativeAcceptanceAutomation = Schema.Literals(["off", "bounded", "until-ready"]);
export type CollaborativeAcceptanceAutomation = typeof CollaborativeAcceptanceAutomation.Type;

export const CollaborativeAcceptanceReviewTrigger = Schema.Literals([
  "manual",
  "first-candidate",
  "each-eligible-candidate",
]);
export type CollaborativeAcceptanceReviewTrigger = typeof CollaborativeAcceptanceReviewTrigger.Type;

export const CollaborativeAcceptanceCommentPolicy = Schema.Literals([
  "blocking-only",
  "all-actionable-addressed",
  "all-review-threads-resolved",
]);
export type CollaborativeAcceptanceCommentPolicy = typeof CollaborativeAcceptanceCommentPolicy.Type;

export const CollaborativeAcceptanceReviewWorkflow = Schema.Struct({
  identity: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
});
export type CollaborativeAcceptanceReviewWorkflow =
  typeof CollaborativeAcceptanceReviewWorkflow.Type;

export const CollaborativeAcceptanceReviewCandidate = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  candidateId: CollaborativeAcceptanceCandidateId,
  reviewEpoch: PositiveInt,
  headSha: TrimmedNonEmptyString,
  contractRevision: TrimmedNonEmptyString,
  reviewWorkflow: CollaborativeAcceptanceReviewWorkflow,
  coverage: Schema.Struct({
    required: Schema.Array(TrimmedNonEmptyString),
    covered: Schema.Array(TrimmedNonEmptyString),
    applicability: Schema.Literals(["known", "unknown"]),
  }),
  previousFindingVerification: Schema.Struct({
    required: Schema.Boolean,
    complete: Schema.Boolean,
    verifiedRevisionIds: Schema.Array(TrimmedNonEmptyString),
    unresolvedRevisionIds: Schema.Array(TrimmedNonEmptyString),
  }),
});
export type CollaborativeAcceptanceReviewCandidate =
  typeof CollaborativeAcceptanceReviewCandidate.Type;

export const CollaborativeAcceptanceBudgets = Schema.Struct({
  exchanges: NonNegativeInt,
  modelSpendCents: NonNegativeInt,
  retries: NonNegativeInt,
  disputeRounds: NonNegativeInt,
  executionDurationSeconds: NonNegativeInt,
  waitingDeadlineSeconds: NonNegativeInt,
});
export type CollaborativeAcceptanceBudgets = typeof CollaborativeAcceptanceBudgets.Type;

export const CollaborativeAcceptancePolicy = Schema.Struct({
  automation: CollaborativeAcceptanceAutomation,
  reviewTrigger: CollaborativeAcceptanceReviewTrigger,
  reviewWorkflow: CollaborativeAcceptanceReviewWorkflow,
  commentPolicy: CollaborativeAcceptanceCommentPolicy,
  budgets: CollaborativeAcceptanceBudgets,
});
export type CollaborativeAcceptancePolicy = typeof CollaborativeAcceptancePolicy.Type;

export const CollaborativeAcceptanceEvidenceKind = Schema.Literals([
  "criterion",
  "provider-review",
  "provider-review-thread",
  "provider-comment",
  "provider-check",
  "provider-mergeability",
  "assessment",
  "test",
  "artifact",
  "manual",
]);
export type CollaborativeAcceptanceEvidenceKind = typeof CollaborativeAcceptanceEvidenceKind.Type;

export const CollaborativeAcceptanceCriterion = Schema.Struct({
  criterionId: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  required: Schema.Boolean,
  evidenceKinds: Schema.Array(CollaborativeAcceptanceEvidenceKind),
});
export type CollaborativeAcceptanceCriterion = typeof CollaborativeAcceptanceCriterion.Type;

export const CollaborativeAcceptanceExecutionPhase = Schema.Literals([
  "implementing",
  "verifying",
  "monitoring",
  "paused",
  "needs-human",
]);
export type CollaborativeAcceptanceExecutionPhase =
  typeof CollaborativeAcceptanceExecutionPhase.Type;

export const CollaborativeAcceptancePauseReason = Schema.Literals([
  "circular-wait",
  "budget-exhausted",
  "retry-limit",
  "dispute-limit",
  "duration-limit",
  "model-spend-limit",
  "waiting-deadline",
  "participant-unavailable",
  "provider-failure",
  "closed-pull-request",
  "contradictory-contract",
  "stale-head",
  "ambiguous-outcome",
]);
export type CollaborativeAcceptancePauseReason = typeof CollaborativeAcceptancePauseReason.Type;

/**
 * Immutable provenance captured at admission. Provider adapters and prompt builders must
 * forward this object; they must not reconstruct it from a current checkout or thread metadata.
 */
export const CollaborativeAcceptanceProvenance = Schema.Struct({
  assignmentId: TrimmedNonEmptyString,
  dispatchId: Schema.NullOr(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  generation: Schema.optional(NonNegativeInt),
  caseId: CollaborativeAcceptanceCaseId,
  candidateId: CollaborativeAcceptanceCandidateId,
  headSha: TrimmedNonEmptyString,
  contractRevision: TrimmedNonEmptyString,
  reviewWorkflow: CollaborativeAcceptanceReviewWorkflow,
});
export type CollaborativeAcceptanceProvenance = typeof CollaborativeAcceptanceProvenance.Type;

export const CollaborativeAcceptanceCandidate = Schema.Struct({
  candidateId: CollaborativeAcceptanceCandidateId,
  reviewEpoch: PositiveInt,
  headSha: TrimmedNonEmptyString,
  contractRevision: TrimmedNonEmptyString,
  reviewWorkflow: CollaborativeAcceptanceReviewWorkflow,
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  provenance: Schema.optional(CollaborativeAcceptanceProvenance),
  reviewCandidate: Schema.optional(Schema.Unknown),
  createdAt: IsoDateTime,
});
export type CollaborativeAcceptanceCandidate = typeof CollaborativeAcceptanceCandidate.Type;

export const CollaborativeAcceptanceEvidence = Schema.Struct({
  evidenceId: CollaborativeAcceptanceEvidenceId,
  caseId: CollaborativeAcceptanceCaseId,
  candidateId: CollaborativeAcceptanceCandidateId,
  headSha: TrimmedNonEmptyString,
  kind: CollaborativeAcceptanceEvidenceKind,
  criterionId: Schema.NullOr(TrimmedNonEmptyString),
  sourceId: TrimmedNonEmptyString,
  summary: Schema.String,
  complete: Schema.Boolean,
  current: Schema.Boolean,
  observedAt: IsoDateTime,
});
export type CollaborativeAcceptanceEvidence = typeof CollaborativeAcceptanceEvidence.Type;

export const CollaborativeAcceptanceAssessmentRole = Schema.Literals([
  "child-implementer",
  "parent-reviewer",
]);
export type CollaborativeAcceptanceAssessmentRole =
  typeof CollaborativeAcceptanceAssessmentRole.Type;

export const CollaborativeAcceptanceAssessmentKind = Schema.Literals([
  "attestation",
  "acknowledgement",
]);
export type CollaborativeAcceptanceAssessmentKind =
  typeof CollaborativeAcceptanceAssessmentKind.Type;

export const CollaborativeAcceptanceAssessmentOutcome = Schema.Literals([
  "pass",
  "fail",
  "inconclusive",
  "acknowledged",
]);
export type CollaborativeAcceptanceAssessmentOutcome =
  typeof CollaborativeAcceptanceAssessmentOutcome.Type;

export const CollaborativeAcceptanceAssessment = Schema.Struct({
  assessmentId: CollaborativeAcceptanceAssessmentId,
  caseId: CollaborativeAcceptanceCaseId,
  role: CollaborativeAcceptanceAssessmentRole,
  kind: CollaborativeAcceptanceAssessmentKind,
  outcome: CollaborativeAcceptanceAssessmentOutcome,
  candidateId: CollaborativeAcceptanceCandidateId,
  reviewEpoch: PositiveInt,
  headSha: TrimmedNonEmptyString,
  contractRevision: TrimmedNonEmptyString,
  reviewWorkflow: CollaborativeAcceptanceReviewWorkflow,
  criteriaEvidenceIds: Schema.Array(CollaborativeAcceptanceEvidenceId),
  createdAt: IsoDateTime,
});
export type CollaborativeAcceptanceAssessment = typeof CollaborativeAcceptanceAssessment.Type;

export const CollaborativeAcceptanceProviderCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  headSha: TrimmedNonEmptyString,
});
export type CollaborativeAcceptanceProviderCheck = typeof CollaborativeAcceptanceProviderCheck.Type;

export const CollaborativeAcceptanceRequiredCheckCoverage = Schema.Struct({
  expected: Schema.Array(TrimmedNonEmptyString),
  observed: Schema.Array(CollaborativeAcceptanceProviderCheck),
  completeness: Schema.Literals(["complete", "missing", "unknown", "extra"]),
});
export type CollaborativeAcceptanceRequiredCheckCoverage =
  typeof CollaborativeAcceptanceRequiredCheckCoverage.Type;

export const CollaborativeAcceptanceProviderEvidence = Schema.Struct({
  caseId: Schema.optional(CollaborativeAcceptanceCaseId),
  candidateId: CollaborativeAcceptanceCandidateId,
  headSha: TrimmedNonEmptyString,
  sourceId: Schema.optional(TrimmedNonEmptyString),
  sourceRevision: TrimmedNonEmptyString,
  complete: Schema.Boolean,
  pullRequestState: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  reviewEvidenceComplete: Schema.Boolean,
  reviewThreadEvidenceComplete: Schema.Boolean,
  commentEvidenceComplete: Schema.Boolean,
  checkEvidenceComplete: Schema.Boolean,
  requiredChecksKnown: Schema.Boolean,
  requiredChecks: Schema.Array(CollaborativeAcceptanceProviderCheck),
  requiredCheckCoverage: Schema.optional(CollaborativeAcceptanceRequiredCheckCoverage),
  unresolvedActionableFindings: NonNegativeInt,
  unresolvedReviewThreads: NonNegativeInt,
  observedAt: IsoDateTime,
});
export type CollaborativeAcceptanceProviderEvidence =
  typeof CollaborativeAcceptanceProviderEvidence.Type;

export const CollaborativeAcceptanceExchangeStatus = Schema.Literals([
  "reserved",
  "committed",
  "outcome-recorded",
  "completed",
  "cancelled",
]);
export type CollaborativeAcceptanceExchangeStatus =
  typeof CollaborativeAcceptanceExchangeStatus.Type;

export const CollaborativeAcceptanceExchange = Schema.Struct({
  exchangeId: CollaborativeAcceptanceExchangeId,
  caseId: CollaborativeAcceptanceCaseId,
  executionId: CollaborativeAcceptanceExecutionId,
  candidateId: Schema.optional(CollaborativeAcceptanceCandidateId),
  headSha: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(TrimmedNonEmptyString),
  reviewMode: Schema.optional(Schema.Literals(["full", "delta"])),
  status: CollaborativeAcceptanceExchangeStatus,
  retryCount: NonNegativeInt,
  reservedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  outcomeRecordedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  cancelledAt: Schema.NullOr(IsoDateTime),
  modelSpendCents: NonNegativeInt,
  dispatchAttempt: Schema.optional(NonNegativeInt),
  dispatchAttemptId: Schema.optional(TrimmedNonEmptyString),
  dispatchStartedAt: Schema.optional(IsoDateTime),
  dispatchOutcomeAt: Schema.optional(IsoDateTime),
  dispatchState: Schema.optional(
    Schema.Literals([
      "pending",
      "succeeded",
      "transient-failure",
      "ambiguous-failure",
      "permanent-failure",
      "cancelled",
    ]),
  ),
  dispatchOutcome: Schema.optional(
    Schema.Literals(["transient", "ambiguous", "permanent", "unavailable"]),
  ),
  retryLineageId: Schema.optional(TrimmedNonEmptyString),
  admission: Schema.optional(
    Schema.Struct({
      senderThreadId: ThreadId,
      recipientThreadId: ThreadId,
      kind: Schema.Literals(["clarification", "decision", "review", "remediation"]),
      blocking: Schema.Boolean,
      senderAuthority: Schema.Struct({
        executionId: TrimmedNonEmptyString,
        assignmentId: Schema.optional(TrimmedNonEmptyString),
        generation: NonNegativeInt,
        threadId: Schema.optional(ThreadId),
        dispatchId: Schema.NullOr(TrimmedNonEmptyString),
        turnId: Schema.NullOr(TrimmedNonEmptyString),
      }),
      recipientAuthority: Schema.Struct({
        executionId: TrimmedNonEmptyString,
        assignmentId: Schema.optional(TrimmedNonEmptyString),
        generation: NonNegativeInt,
        threadId: Schema.optional(ThreadId),
        dispatchId: Schema.NullOr(TrimmedNonEmptyString),
        turnId: Schema.NullOr(TrimmedNonEmptyString),
      }),
      producingExecution: Schema.Struct({
        executionId: TrimmedNonEmptyString,
        assignmentId: Schema.optional(TrimmedNonEmptyString),
        generation: NonNegativeInt,
        threadId: Schema.optional(ThreadId),
        dispatchId: Schema.NullOr(TrimmedNonEmptyString),
        turnId: Schema.NullOr(TrimmedNonEmptyString),
      }),
      payloadRef: Schema.Struct({
        ref: TrimmedNonEmptyString,
        sha256: TrimmedNonEmptyString,
      }),
      candidateRefs: Schema.Array(CollaborativeAcceptanceCandidateId),
      findingRefs: Schema.Array(TrimmedNonEmptyString),
      supersedesRequestId: Schema.NullOr(TrimmedNonEmptyString),
      deliveryJson: TrimmedNonEmptyString,
      createdAt: IsoDateTime,
    }),
  ),
});
export type CollaborativeAcceptanceExchange = typeof CollaborativeAcceptanceExchange.Type;

export const CollaborativeAcceptanceObligation = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  caseId: CollaborativeAcceptanceCaseId,
  ownerThreadId: ThreadId,
  status: Schema.Literals([
    "open",
    "satisfied",
    "cancelled",
    "superseded",
    "unavailable",
    "failed",
    "needs-human",
    "disposed",
  ]),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type CollaborativeAcceptanceObligation = typeof CollaborativeAcceptanceObligation.Type;

export const CollaborativeAcceptanceLifecycle = Schema.Literals([
  "pending",
  "awaiting-review",
  "changes-requested",
  "verifying",
  "monitoring",
  "accepted",
]);
export type CollaborativeAcceptanceLifecycle = typeof CollaborativeAcceptanceLifecycle.Type;

export const CollaborativeAcceptanceCollaborationStatus = Schema.Literals([
  "none",
  "child-assessment-pending",
  "parent-assessment-pending",
  "changes-requested",
  "human-input-required",
  "exchange-pending",
]);
export type CollaborativeAcceptanceCollaborationStatus =
  typeof CollaborativeAcceptanceCollaborationStatus.Type;

export const CollaborativeAcceptanceReadiness = Schema.Literals([
  "ready-now",
  "no-known-blockers",
  "blocked",
]);
export type CollaborativeAcceptanceReadiness = typeof CollaborativeAcceptanceReadiness.Type;

/**
 * Transport integration seam: request correlation carries this case and exchange identity
 * into the later request/response module. This module owns exchange state; transport does not.
 */
export const CollaborativeAcceptanceRequestTransportContext = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  exchangeId: CollaborativeAcceptanceExchangeId,
});
export type CollaborativeAcceptanceRequestTransportContext =
  typeof CollaborativeAcceptanceRequestTransportContext.Type;

export const CollaborativeAcceptanceProjection = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  candidateId: CollaborativeAcceptanceCandidateId,
  headSha: TrimmedNonEmptyString,
  executionPhase: CollaborativeAcceptanceExecutionPhase,
  collaborationStatus: CollaborativeAcceptanceCollaborationStatus,
  acceptanceLifecycle: CollaborativeAcceptanceLifecycle,
  readiness: CollaborativeAcceptanceReadiness,
  reasons: Schema.Array(TrimmedNonEmptyString),
  staleAssessmentIds: Schema.Array(CollaborativeAcceptanceAssessmentId),
  pauseReason: Schema.optional(CollaborativeAcceptancePauseReason),
  activeExchangeId: Schema.optional(CollaborativeAcceptanceExchangeId),
  updatedAt: IsoDateTime,
});
export type CollaborativeAcceptanceProjection = typeof CollaborativeAcceptanceProjection.Type;

export const CollaborativeAcceptanceCase = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  assignmentId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  pullRequest: PullRequestRef,
  contractRevision: TrimmedNonEmptyString,
  currentCandidate: CollaborativeAcceptanceCandidate,
  criteria: Schema.Array(CollaborativeAcceptanceCriterion),
  policy: CollaborativeAcceptancePolicy,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CollaborativeAcceptanceCase = typeof CollaborativeAcceptanceCase.Type;

export const CollaborativeAcceptanceRecord = Schema.Struct({
  revision: NonNegativeInt,
  case: CollaborativeAcceptanceCase,
  candidates: Schema.Array(CollaborativeAcceptanceCandidate),
  evidence: Schema.Array(CollaborativeAcceptanceEvidence),
  providerEvidence: Schema.optional(Schema.NullOr(CollaborativeAcceptanceProviderEvidence)),
  assessments: Schema.Array(CollaborativeAcceptanceAssessment),
  exchanges: Schema.Array(CollaborativeAcceptanceExchange),
  obligations: Schema.optional(Schema.Array(CollaborativeAcceptanceObligation)),
  projection: CollaborativeAcceptanceProjection,
});
export type CollaborativeAcceptanceRecord = typeof CollaborativeAcceptanceRecord.Type;

export const CollaborativeAcceptanceCandidateSubmission = Schema.Struct({
  caseId: Schema.optional(CollaborativeAcceptanceCaseId),
  assignmentId: TrimmedNonEmptyString,
  candidate: CollaborativeAcceptanceCandidate,
  pullRequest: PullRequestRef,
  criteria: Schema.Array(CollaborativeAcceptanceCriterion),
  /**
   * Compatibility input only. The server captures its saved policy for a new
   * case and reuses the durable case policy for later candidates.
   */
  policy: CollaborativeAcceptancePolicy,
  initialEvidence: Schema.Array(CollaborativeAcceptanceEvidence),
  reviewCandidate: CollaborativeAcceptanceReviewCandidate,
});
export type CollaborativeAcceptanceCandidateSubmission =
  typeof CollaborativeAcceptanceCandidateSubmission.Type;

export const CollaborativeAcceptanceAssessmentSubmission = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  assessment: CollaborativeAcceptanceAssessment,
});
export type CollaborativeAcceptanceAssessmentSubmission =
  typeof CollaborativeAcceptanceAssessmentSubmission.Type;

export const CollaborativeAcceptanceStatus = Schema.Struct({
  record: Schema.NullOr(CollaborativeAcceptanceRecord),
  pauseReason: Schema.NullOr(CollaborativeAcceptancePauseReason),
});
export type CollaborativeAcceptanceStatus = typeof CollaborativeAcceptanceStatus.Type;

export const CollaborativeAcceptanceCaseLookupInput = Schema.Struct({
  /** Authenticated PR-associated thread used to authorize lookup, not the case selector. */
  threadId: ThreadId,
  pullRequest: PullRequestRef,
});
export type CollaborativeAcceptanceCaseLookupInput =
  typeof CollaborativeAcceptanceCaseLookupInput.Type;

export const CollaborativeAcceptanceCaseLookupResult = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  status: CollaborativeAcceptanceStatus,
});
export type CollaborativeAcceptanceCaseLookupResult =
  typeof CollaborativeAcceptanceCaseLookupResult.Type;

export const CollaborativeAcceptanceCaseLookupReason = Schema.Literals([
  "not-found",
  "ambiguous",
  "unauthorized",
  "unavailable",
]);
export type CollaborativeAcceptanceCaseLookupReason =
  typeof CollaborativeAcceptanceCaseLookupReason.Type;

export class CollaborativeAcceptanceCaseLookupError extends Schema.TaggedErrorClass<CollaborativeAcceptanceCaseLookupError>()(
  "CollaborativeAcceptanceCaseLookupError",
  {
    message: Schema.String,
    reason: CollaborativeAcceptanceCaseLookupReason,
  },
) {}

export class CollaborativeAcceptanceError extends Schema.TaggedErrorClass<CollaborativeAcceptanceError>()(
  "CollaborativeAcceptanceError",
  {
    message: Schema.String,
    reason: Schema.optional(CollaborativeAcceptancePauseReason),
    caseId: Schema.optional(CollaborativeAcceptanceCaseId),
  },
) {}

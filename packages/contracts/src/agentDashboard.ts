import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RepositoryIdentity } from "./environment.ts";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { OrchestrationLatestTurn, OrchestrationSessionStatus } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentDashboardGetSnapshotInput = Schema.Struct({});
export type AgentDashboardGetSnapshotInput = typeof AgentDashboardGetSnapshotInput.Type;

export const AgentDashboardVcsAvailability = Schema.Literals([
  "available",
  "not-a-repository",
  "unavailable",
]);
export type AgentDashboardVcsAvailability = typeof AgentDashboardVcsAvailability.Type;

export const AgentDashboardVcsState = Schema.Literals(["clean", "dirty", "unknown"]);
export type AgentDashboardVcsState = typeof AgentDashboardVcsState.Type;

export const AgentDashboardThreadState = Schema.Literals([
  "running",
  "needs-input",
  "error",
  "ready",
  "paused",
  "idle",
]);
export type AgentDashboardThreadState = typeof AgentDashboardThreadState.Type;

/** Stable native project reference used by dashboard records for navigation. */
export const AgentDashboardRepositoryRef = Schema.Struct({
  projectId: ProjectId,
});
export type AgentDashboardRepositoryRef = typeof AgentDashboardRepositoryRef.Type;

/** Stable native thread reference used by dashboard records for navigation. */
export const AgentDashboardThreadRef = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type AgentDashboardThreadRef = typeof AgentDashboardThreadRef.Type;

export const AgentDashboardVcsStatus = Schema.Struct({
  availability: AgentDashboardVcsAvailability,
  isRepo: Schema.Boolean,
  state: AgentDashboardVcsState,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  isDefaultBranch: Schema.Boolean,
  hasUpstream: Schema.NullOr(Schema.Boolean),
  aheadCount: Schema.NullOr(NonNegativeInt),
  behindCount: Schema.NullOr(NonNegativeInt),
  aheadOfDefaultCount: Schema.NullOr(NonNegativeInt),
});
export type AgentDashboardVcsStatus = typeof AgentDashboardVcsStatus.Type;

export const AgentDashboardAgent = Schema.Struct({
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: OrchestrationSessionStatus,
  activeTurnId: Schema.NullOr(TurnId),
  updatedAt: IsoDateTime,
});
export type AgentDashboardAgent = typeof AgentDashboardAgent.Type;

export const AgentDashboardThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  agent: Schema.NullOr(AgentDashboardAgent),
  state: AgentDashboardThreadState.pipe(Schema.withDecodingDefault(Effect.succeed("idle"))),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  hasPendingApprovals: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hasPendingUserInput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hasActionableProposedPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  updatedAt: IsoDateTime,
});
export type AgentDashboardThread = typeof AgentDashboardThread.Type;

export const AgentDashboardWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  threads: Schema.Array(AgentDashboardThread),
});
export type AgentDashboardWorktree = typeof AgentDashboardWorktree.Type;

export const AgentDashboardRepository = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  vcs: AgentDashboardVcsStatus,
  threads: Schema.Array(AgentDashboardThread),
  worktrees: Schema.Array(AgentDashboardWorktree),
});
export type AgentDashboardRepository = typeof AgentDashboardRepository.Type;

export const AgentDashboardFeedKind = Schema.Literals(["activity", "session", "turn", "attention"]);
export type AgentDashboardFeedKind = typeof AgentDashboardFeedKind.Type;

export const AgentDashboardFeedStatus = Schema.Literals([
  "info",
  "running",
  "needs-input",
  "error",
  "ready",
  "paused",
  "completed",
]);
export type AgentDashboardFeedStatus = typeof AgentDashboardFeedStatus.Type;

/** The durable feed level used by the former standalone agent widget. */
export const AgentDashboardFeedLevel = Schema.Literals(["info", "success", "warn", "error"]);
export type AgentDashboardFeedLevel = typeof AgentDashboardFeedLevel.Type;

export const AgentDashboardFeedAction = Schema.Struct({
  label: TrimmedNonEmptyString,
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  file: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  reveal: Schema.optional(Schema.Boolean),
});
export type AgentDashboardFeedAction = typeof AgentDashboardFeedAction.Type;

/** Origin metadata used to connect an external feed card back to T3. */
export const AgentDashboardFeedOrigin = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  projectName: Schema.NullOr(TrimmedNonEmptyString),
  projectPath: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
});
export type AgentDashboardFeedOrigin = typeof AgentDashboardFeedOrigin.Type;

/**
 * The original agent-widget card, normalized into a T3-owned contract.
 * Structured chart/research/focus payloads remain opaque so migrating older
 * cards does not discard fields the standalone renderer knew how to display.
 */
export const AgentDashboardFeedCard = Schema.Struct({
  id: NonNegativeInt,
  ts: Schema.Number,
  agent: TrimmedNonEmptyString,
  kind: Schema.NullOr(TrimmedNonEmptyString),
  title: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.NullOr(TrimmedNonEmptyString),
  imageUrl: Schema.NullOr(TrimmedNonEmptyString),
  level: AgentDashboardFeedLevel,
  tags: Schema.Array(TrimmedNonEmptyString),
  chart: Schema.optional(Schema.Unknown),
  research: Schema.optional(Schema.Unknown),
  focus: Schema.optional(Schema.Unknown),
  actions: Schema.Array(AgentDashboardFeedAction),
  /** Optional so cards written by older feed clients continue to decode. */
  origin: Schema.NullOr(AgentDashboardFeedOrigin).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentDashboardFeedCard = typeof AgentDashboardFeedCard.Type;

/** Durable intelligent-research finding migrated from Hermes. */
export const AgentDashboardResearchFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  timestamp: TrimmedNonEmptyString,
  abstract: Schema.NullOr(TrimmedNonEmptyString),
  authors: Schema.Array(TrimmedNonEmptyString),
  published: Schema.NullOr(TrimmedNonEmptyString),
  categories: Schema.Array(TrimmedNonEmptyString),
  relevanceScore: NonNegativeInt,
  topicContext: Schema.NullOr(TrimmedNonEmptyString),
  repositories: Schema.Array(TrimmedNonEmptyString),
  watchDir: Schema.NullOr(TrimmedNonEmptyString),
  sinceDays: Schema.NullOr(NonNegativeInt),
  pdfUrl: Schema.NullOr(TrimmedNonEmptyString),
  citationCount: Schema.NullOr(NonNegativeInt),
  occurrences: NonNegativeInt,
});
export type AgentDashboardResearchFinding = typeof AgentDashboardResearchFinding.Type;

export const AgentDashboardReviewSuggestionRepository = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  githubRepo: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentDashboardReviewSuggestionRepository =
  typeof AgentDashboardReviewSuggestionRepository.Type;

export const AgentDashboardReviewSuggestionIssue = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  number: Schema.NullOr(NonNegativeInt),
});
export type AgentDashboardReviewSuggestionIssue = typeof AgentDashboardReviewSuggestionIssue.Type;

/** Durable repository-review suggestion migrated from Hermes. */
export const AgentDashboardReviewSuggestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  profile: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "accepted", "dismissed", "blocked"]),
  createdAt: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(TrimmedNonEmptyString),
  repository: AgentDashboardReviewSuggestionRepository,
  category: TrimmedNonEmptyString,
  impact: TrimmedNonEmptyString,
  confidence: TrimmedNonEmptyString,
  evidence: Schema.Array(TrimmedNonEmptyString),
  nextStep: TrimmedNonEmptyString,
  report: TrimmedNonEmptyString,
  githubIssue: AgentDashboardReviewSuggestionIssue,
  jobId: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentDashboardReviewSuggestion = typeof AgentDashboardReviewSuggestion.Type;

export const AgentDashboardFeedCardIdInput = Schema.Struct({ id: NonNegativeInt });
export type AgentDashboardFeedCardIdInput = typeof AgentDashboardFeedCardIdInput.Type;

export const AgentDashboardReviewSuggestionAction = Schema.Literals(["dismiss", "block"]);
export type AgentDashboardReviewSuggestionAction = typeof AgentDashboardReviewSuggestionAction.Type;

export const AgentDashboardReviewSuggestionActionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: AgentDashboardReviewSuggestionAction,
});
export type AgentDashboardReviewSuggestionActionInput =
  typeof AgentDashboardReviewSuggestionActionInput.Type;

export const AgentDashboardReviewSuggestionIdInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AgentDashboardReviewSuggestionIdInput =
  typeof AgentDashboardReviewSuggestionIdInput.Type;

/**
 * Truthful mutation outcome. Producers must set this explicitly for new code.
 * Older `{ ok: boolean }` payloads still decode; missing `outcome` defaults to
 * `"applied"` so existing clients that only check `ok` keep working.
 */
export const AgentDashboardMutationOutcome = Schema.Literals([
  "applied",
  "noop",
  "not-found",
  "rejected",
  "failed",
]);
export type AgentDashboardMutationOutcome = typeof AgentDashboardMutationOutcome.Type;

export const AgentDashboardMutationResult = Schema.Struct({
  ok: Schema.Boolean,
  outcome: AgentDashboardMutationOutcome.pipe(
    Schema.withDecodingDefault(Effect.succeed("applied")),
  ),
  message: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  targetId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  targetUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentDashboardMutationResult = typeof AgentDashboardMutationResult.Type;

// ── Canonical automation domain (ADW-01) ───────────────────────

/** Full lifecycle for a single automation job through result ingestion. */
export const AgentDashboardAutomationRunStatus = Schema.Literals([
  "queued",
  "running",
  "ingesting",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
export type AgentDashboardAutomationRunStatus = typeof AgentDashboardAutomationRunStatus.Type;

export const AgentDashboardAutomationRunTrigger = Schema.Literals(["manual", "scheduled", "retry"]);
export type AgentDashboardAutomationRunTrigger = typeof AgentDashboardAutomationRunTrigger.Type;

/**
 * Durable history for one automation attempt. Success is only meaningful after
 * structured findings have been ingested (see ADW-03 orchestration).
 */
export const AgentDashboardAutomationRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: AgentDashboardAutomationRunStatus,
  trigger: AgentDashboardAutomationRunTrigger,
  /** Logical automation kind, e.g. `repository-review`. */
  kind: TrimmedNonEmptyString,
  repository: AgentDashboardRepositoryRef,
  /** Human-readable target label (branch, path, or check set). */
  target: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  /**
   * Opaque job/correlation id used by workers. Never included in finding
   * fingerprints — otherwise the same issue reappears every run.
   */
  jobId: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  /** Zero-based retry count for this run lineage. */
  retryCount: NonNegativeInt,
  findingCount: NonNegativeInt,
  /** Opaque accounting units when known; null means unmeasured. */
  costUnits: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type AgentDashboardAutomationRun = typeof AgentDashboardAutomationRun.Type;

export const AgentDashboardFindingSeverity = Schema.Literals([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
export type AgentDashboardFindingSeverity = typeof AgentDashboardFindingSeverity.Type;

export const AgentDashboardFindingConfidence = Schema.Literals(["low", "medium", "high"]);
export type AgentDashboardFindingConfidence = typeof AgentDashboardFindingConfidence.Type;

/** Stable product taxonomy shared by producers, persistence, filters, and automation. */
export const AgentDashboardFindingType = Schema.Literals([
  "bug",
  "security",
  "research",
  "improvement",
  "review",
  "operations",
]);
export type AgentDashboardFindingType = typeof AgentDashboardFindingType.Type;

export const AgentDashboardFindingKind = Schema.Literals([
  "review",
  "research",
  "security",
  "engineering",
  "operational",
]);
export type AgentDashboardFindingKind = typeof AgentDashboardFindingKind.Type;

/**
 * Source vs collection times so UI can warn about stale data without guessing.
 * `sourceAt` is when the underlying system asserted the fact; `collectedAt` is
 * when T3 normalized and stored it.
 */
export const AgentDashboardProvenance = Schema.Struct({
  source: TrimmedNonEmptyString,
  sourceAt: Schema.NullOr(IsoDateTime),
  collectedAt: IsoDateTime,
});
export type AgentDashboardProvenance = typeof AgentDashboardProvenance.Type;

/**
 * Reversible lifecycle for a finding. `reopen` is a transition back to `open`,
 * not a durable state. Existing review-suggestion statuses (pending/accepted/
 * dismissed/blocked) map onto open/acknowledged/dismissed/blocked. `done`
 * records completed work and remains reversible through `reopen`.
 */
export const AgentDashboardDispositionState = Schema.Literals([
  "open",
  "in-progress",
  "acknowledged",
  "snoozed",
  "assigned",
  "done",
  "dismissed",
  "blocked",
]);
export type AgentDashboardDispositionState = typeof AgentDashboardDispositionState.Type;

export const AgentDashboardDisposition = Schema.Struct({
  state: AgentDashboardDispositionState,
  updatedAt: IsoDateTime,
  actor: Schema.NullOr(TrimmedNonEmptyString),
  note: Schema.NullOr(TrimmedNonEmptyString),
  snoozeUntil: Schema.NullOr(IsoDateTime),
  assignee: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentDashboardDisposition = typeof AgentDashboardDisposition.Type;

export const AgentDashboardDispositionAction = Schema.Literals([
  "acknowledge",
  "snooze",
  "assign",
  "complete",
  "dismiss",
  "block",
  "reopen",
]);
export type AgentDashboardDispositionAction = typeof AgentDashboardDispositionAction.Type;

export const AgentDashboardDispositionActionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: AgentDashboardDispositionAction,
  snoozeUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  assignee: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  note: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type AgentDashboardDispositionActionInput = typeof AgentDashboardDispositionActionInput.Type;

export const AgentDashboardFindingReadiness = Schema.Literals(["needs-research", "ready"]);
export type AgentDashboardFindingReadiness = typeof AgentDashboardFindingReadiness.Type;

export const AgentDashboardFindingTarget = Schema.Struct({
  path: TrimmedNonEmptyString,
  symbol: Schema.NullOr(TrimmedNonEmptyString),
  evidence: TrimmedNonEmptyString,
});
export type AgentDashboardFindingTarget = typeof AgentDashboardFindingTarget.Type;

export const AgentDashboardFindingSource = Schema.Struct({
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
});
export type AgentDashboardFindingSource = typeof AgentDashboardFindingSource.Type;

export const AgentDashboardRiskTier = Schema.Literals(["low", "medium", "high", "critical"]);
export type AgentDashboardRiskTier = typeof AgentDashboardRiskTier.Type;

export const AgentDashboardFindingEffort = Schema.Literals(["small", "medium", "large"]);
export type AgentDashboardFindingEffort = typeof AgentDashboardFindingEffort.Type;

/** Concrete repository adoption plan required before research can start implementation work. */
export const AgentDashboardFindingActionability = Schema.Struct({
  readiness: AgentDashboardFindingReadiness,
  proposal: TrimmedNonEmptyString,
  expectedValue: TrimmedNonEmptyString,
  targets: Schema.Array(AgentDashboardFindingTarget),
  validationPlan: Schema.Array(TrimmedNonEmptyString),
  sources: Schema.Array(AgentDashboardFindingSource),
  /** Estimated implementation risk, independent from finding severity. */
  riskTier: AgentDashboardRiskTier.pipe(Schema.withDecodingDefault(Effect.succeed("medium"))),
  estimatedEffort: AgentDashboardFindingEffort.pipe(
    Schema.withDecodingDefault(Effect.succeed("medium")),
  ),
  /** Human-readable qualification result shown whenever work is not ready. */
  qualificationReason: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  qualifiedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  qualifiedBy: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Occurrence count observed by the qualifier, used to re-open changed signals. */
  qualifiedOccurrenceCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type AgentDashboardFindingActionability = typeof AgentDashboardFindingActionability.Type;

/**
 * Canonical finding. `fingerprint` is the stable cross-run identity and MUST
 * NOT incorporate jobId or runId so the same issue collapses across retries.
 */
export const AgentDashboardFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  type: AgentDashboardFindingType.pipe(Schema.withDecodingDefault(Effect.succeed("review"))),
  kind: AgentDashboardFindingKind,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  severity: AgentDashboardFindingSeverity,
  confidence: AgentDashboardFindingConfidence,
  category: Schema.NullOr(TrimmedNonEmptyString),
  evidence: Schema.Array(TrimmedNonEmptyString),
  repository: AgentDashboardRepositoryRef,
  /** Display/path label when project identity alone is not enough. */
  repositoryPath: Schema.NullOr(TrimmedNonEmptyString),
  disposition: AgentDashboardDisposition,
  provenance: AgentDashboardProvenance,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  occurrenceCount: NonNegativeInt,
  lastRunId: Schema.NullOr(TrimmedNonEmptyString),
  thread: Schema.NullOr(AgentDashboardThreadRef),
  externalIssueUrl: Schema.NullOr(TrimmedNonEmptyString),
  actionability: Schema.NullOr(AgentDashboardFindingActionability).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentDashboardFinding = typeof AgentDashboardFinding.Type;

/** Per-repository scheduling and runtime policy (consumed by ADW-06). */
export const AgentDashboardAutomationKind = Schema.Literals([
  "repository-review",
  "continuous-improvement",
  "pull-request-rollup",
  "inactive-worktree-cleanup",
  "product-opportunity-discovery",
  "decision-follow-up",
]);
export type AgentDashboardAutomationKind = typeof AgentDashboardAutomationKind.Type;

export const AgentDashboardProductContextPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(500),
  Schema.isPattern(/^(?![\\/])(?![a-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\r\n]+\.md$/iu),
);
export type AgentDashboardProductContextPath = typeof AgentDashboardProductContextPath.Type;

export const AgentDashboardRepositoryPolicy = Schema.Struct({
  repository: AgentDashboardRepositoryRef,
  enabled: Schema.Boolean,
  /** Missing on older policies means every automation type is enabled. */
  enabledAutomations: Schema.optional(Schema.Array(AgentDashboardAutomationKind)),
  /** Explicit exclusions; when present, newly introduced automation kinds stay enabled. */
  disabledAutomations: Schema.optional(Schema.Array(AgentDashboardAutomationKind)),
  /** Repository-relative Markdown document used as confirmed product context. */
  productContextPath: Schema.optional(AgentDashboardProductContextPath),
  /** Null until a user confirms that the product context is suitable for automation. */
  productContextConfirmedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  cadenceMinutes: NonNegativeInt,
  /** Higher values win ties when selecting the next overdue repository. */
  priority: NonNegativeInt,
  riskTier: AgentDashboardRiskTier,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  owner: Schema.NullOr(TrimmedNonEmptyString),
  enabledChecks: Schema.Array(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  budgetMinutes: Schema.NullOr(NonNegativeInt),
  maxConcurrentRuns: NonNegativeInt,
  exclusions: Schema.Array(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type AgentDashboardRepositoryPolicy = typeof AgentDashboardRepositoryPolicy.Type;

export const AgentDashboardCoverageStatus = Schema.Literals([
  "never",
  "current",
  "due",
  "overdue",
  "stale",
  "failing",
]);
export type AgentDashboardCoverageStatus = typeof AgentDashboardCoverageStatus.Type;

/** Per-repository coverage and freshness projection. */
export const AgentDashboardRepositoryCoverage = Schema.Struct({
  repository: AgentDashboardRepositoryRef,
  status: AgentDashboardCoverageStatus,
  lastAttemptedAt: Schema.NullOr(IsoDateTime),
  lastSucceededAt: Schema.NullOr(IsoDateTime),
  nextDueAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: NonNegativeInt,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  lastRunId: Schema.NullOr(TrimmedNonEmptyString),
  /** Last terminal run applied to failure/backoff accounting. */
  lastTerminalRunId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  observedAt: IsoDateTime,
});
export type AgentDashboardRepositoryCoverage = typeof AgentDashboardRepositoryCoverage.Type;

export const AgentDashboardExternalActionKind = Schema.Literals([
  "create-github-issue",
  "merge-pull-request",
  "open-thread",
  "run-investigation",
  "assign",
  "other",
]);
export type AgentDashboardExternalActionKind = typeof AgentDashboardExternalActionKind.Type;

export const AgentDashboardExternalActionStatus = Schema.Literals([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
]);
export type AgentDashboardExternalActionStatus = typeof AgentDashboardExternalActionStatus.Type;

/** Record of an external side effect for closed-loop audit (ADW-08/19). */
export const AgentDashboardExternalAction = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardExternalActionKind,
  status: AgentDashboardExternalActionStatus,
  actor: Schema.NullOr(TrimmedNonEmptyString),
  targetId: Schema.NullOr(TrimmedNonEmptyString),
  targetUrl: Schema.NullOr(TrimmedNonEmptyString),
  findingId: Schema.NullOr(TrimmedNonEmptyString),
  runId: Schema.NullOr(TrimmedNonEmptyString),
  result: Schema.NullOr(TrimmedNonEmptyString),
  occurredAt: IsoDateTime,
});
export type AgentDashboardExternalAction = typeof AgentDashboardExternalAction.Type;

/** Collectors are local-first. A missing optional integration is visible rather than silent. */
export const AgentDashboardCollectorKind = Schema.Literals([
  "research",
  "engineering",
  "security",
  "all",
]);
export type AgentDashboardCollectorKind = typeof AgentDashboardCollectorKind.Type;

export const AgentDashboardCollectorStatus = Schema.Literals([
  "available",
  "partial",
  "unavailable",
]);
export type AgentDashboardCollectorStatus = typeof AgentDashboardCollectorStatus.Type;

export const AgentDashboardCollectorState = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardCollectorKind,
  status: AgentDashboardCollectorStatus,
  source: TrimmedNonEmptyString,
  repository: Schema.NullOr(AgentDashboardRepositoryRef),
  message: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: IsoDateTime,
});
export type AgentDashboardCollectorState = typeof AgentDashboardCollectorState.Type;

/** Portfolio-level counters used by the landing page and remote clients. */
export const AgentDashboardPortfolioHealth = Schema.Struct({
  repositoryCount: NonNegativeInt,
  healthyRepositoryCount: NonNegativeInt,
  attentionRepositoryCount: NonNegativeInt,
  /** Repositories that have never completed a successful review cycle. */
  unassessedRepositoryCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  staleRepositoryCount: NonNegativeInt,
  openFindingCount: NonNegativeInt,
  criticalFindingCount: NonNegativeInt,
  activeRunCount: NonNegativeInt,
  lastRunAt: Schema.NullOr(IsoDateTime),
  observedAt: IsoDateTime,
});
export type AgentDashboardPortfolioHealth = typeof AgentDashboardPortfolioHealth.Type;

/** A compact activity item; raw activity payloads stay in the thread read model. */
export const AgentDashboardFeedUpdate = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardFeedKind,
  status: AgentDashboardFeedStatus,
  summary: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  repository: AgentDashboardRepositoryRef,
  thread: Schema.NullOr(AgentDashboardThreadRef),
  activityId: Schema.optional(EventId),
  activityKind: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TurnId),
});
export type AgentDashboardFeedUpdate = typeof AgentDashboardFeedUpdate.Type;

export const AgentDashboardResearchKind = Schema.Literals(["repository", "worktree"]);
export type AgentDashboardResearchKind = typeof AgentDashboardResearchKind.Type;

export const AgentDashboardResearchStatus = Schema.Literals([
  "clean",
  "dirty",
  "behind",
  "ahead",
  "diverged",
  "not-a-repository",
  "unavailable",
]);
export type AgentDashboardResearchStatus = typeof AgentDashboardResearchStatus.Type;

/** A repository/worktree observation derived from T3's known project and VCS state. */
export const AgentDashboardResearchRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardResearchKind,
  status: AgentDashboardResearchStatus,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  observedAt: IsoDateTime,
  repository: AgentDashboardRepositoryRef,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  threadCount: NonNegativeInt,
  activeThreadCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  latestThread: Schema.NullOr(AgentDashboardThreadRef).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentDashboardResearchRecord = typeof AgentDashboardResearchRecord.Type;

export const AgentDashboardSuggestionKind = Schema.Literals([
  "review-changes",
  "sync-branch",
  "respond-to-thread",
  "review-plan",
  "inspect-error",
]);
export type AgentDashboardSuggestionKind = typeof AgentDashboardSuggestionKind.Type;

export const AgentDashboardSuggestionStatus = Schema.Literals(["actionable"]);
export type AgentDashboardSuggestionStatus = typeof AgentDashboardSuggestionStatus.Type;

export const AgentDashboardSuggestionAction = Schema.Literals(["open-repository", "open-thread"]);
export type AgentDashboardSuggestionAction = typeof AgentDashboardSuggestionAction.Type;

/** Runtime status for the consolidated T3 findings portfolio cycle. */
export const AgentDashboardReviewScheduleStatus = Schema.Literals([
  "idle",
  "running",
  "completed",
  "failed",
]);
export type AgentDashboardReviewScheduleStatus = typeof AgentDashboardReviewScheduleStatus.Type;

export const AgentDashboardReviewSchedule = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  intervalMinutes: NonNegativeInt,
  nextRunAt: IsoDateTime,
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastCompletedAt: Schema.NullOr(IsoDateTime),
  lastStatus: AgentDashboardReviewScheduleStatus,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  lastTarget: Schema.NullOr(TrimmedNonEmptyString),
  heartbeatAt: IsoDateTime,
  runCount: NonNegativeInt,
  /** Finding classes the most recent portfolio cycle attempted to cover. */
  lastCoveredTypes: Schema.Array(AgentDashboardFindingType).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Finding classes successfully completed by the most recent portfolio cycle. */
  lastSuccessfulTypes: Schema.Array(AgentDashboardFindingType).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  lastFindingCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  lastReviewRunId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastUnavailableCollectorCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type AgentDashboardReviewSchedule = typeof AgentDashboardReviewSchedule.Type;

/** Runtime status for the T3-owned recurring local security collector. */
export const AgentDashboardSecuritySchedule = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  intervalMinutes: NonNegativeInt,
  nextRunAt: IsoDateTime,
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastCompletedAt: Schema.NullOr(IsoDateTime),
  lastStatus: AgentDashboardReviewScheduleStatus,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  lastTarget: Schema.NullOr(TrimmedNonEmptyString),
  heartbeatAt: IsoDateTime,
  runCount: NonNegativeInt,
});
export type AgentDashboardSecuritySchedule = typeof AgentDashboardSecuritySchedule.Type;

/** A deterministic, native-navigation suggestion derived from current state. */
export const AgentDashboardSuggestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardSuggestionKind,
  status: AgentDashboardSuggestionStatus,
  action: AgentDashboardSuggestionAction,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  repository: AgentDashboardRepositoryRef,
  thread: Schema.NullOr(AgentDashboardThreadRef),
});
export type AgentDashboardSuggestion = typeof AgentDashboardSuggestion.Type;

export const AgentDashboardSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  observedAt: IsoDateTime,
  repositories: Schema.Array(AgentDashboardRepository),
  feed: Schema.Array(AgentDashboardFeedUpdate).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Cards owned by the migrated T3 feed store. */
  externalFeed: Schema.Array(AgentDashboardFeedCard).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  research: Schema.Array(AgentDashboardResearchRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Durable findings migrated from the former intelligent-research page. */
  researchFindings: Schema.Array(AgentDashboardResearchFinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  suggestions: Schema.Array(AgentDashboardSuggestion).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Durable review suggestions migrated from the former Hermes page. */
  reviewSuggestions: Schema.Array(AgentDashboardReviewSuggestion).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Deprecated compatibility alias for `findingsSchedule`. */
  reviewSchedule: Schema.optionalKey(AgentDashboardReviewSchedule),
  /** Consolidated portfolio schedule. `reviewSchedule` remains as a compatibility alias. */
  findingsSchedule: Schema.optionalKey(AgentDashboardReviewSchedule),
  /** Status of the T3-owned recurring local security collector. */
  securitySchedule: Schema.optionalKey(AgentDashboardSecuritySchedule),
  /** Canonical automation run history. Absent on older servers → empty. */
  automationRuns: Schema.Array(AgentDashboardAutomationRun).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Canonical deduplicated findings across sources and runs. */
  findings: Schema.Array(AgentDashboardFinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Per-repository scheduling and runtime policy. */
  repositoryPolicies: Schema.Array(AgentDashboardRepositoryPolicy).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Per-repository coverage and freshness. */
  repositoryCoverage: Schema.Array(AgentDashboardRepositoryCoverage).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** External side-effect audit trail (issues, threads, assignments). */
  externalActions: Schema.Array(AgentDashboardExternalAction).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  collectorStates: Schema.Array(AgentDashboardCollectorState).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  portfolioHealth: Schema.optionalKey(AgentDashboardPortfolioHealth),
});
export type AgentDashboardSnapshot = typeof AgentDashboardSnapshot.Type;

export const AgentDashboardFindingActionInput = AgentDashboardDispositionActionInput;
export type AgentDashboardFindingActionInput = typeof AgentDashboardFindingActionInput.Type;

/** Durable association created when a dashboard finding starts work in T3. */
export const AgentDashboardLinkFindingThreadInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type AgentDashboardLinkFindingThreadInput = typeof AgentDashboardLinkFindingThreadInput.Type;

/**
 * Patch semantics for repository automation policy writes. Repository and
 * timestamp identify the target and mutation; omitted policy fields retain
 * their current values or receive the server default when first created.
 */
export const AgentDashboardRepositoryPolicyInput = Schema.Struct({
  repository: AgentDashboardRepositoryRef,
  enabled: Schema.optional(Schema.Boolean),
  enabledAutomations: Schema.optional(Schema.Array(AgentDashboardAutomationKind)),
  disabledAutomations: Schema.optional(Schema.Array(AgentDashboardAutomationKind)),
  productContextPath: Schema.optional(AgentDashboardProductContextPath),
  productContextConfirmedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  cadenceMinutes: Schema.optional(NonNegativeInt),
  priority: Schema.optional(NonNegativeInt),
  riskTier: Schema.optional(AgentDashboardRiskTier),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  owner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  enabledChecks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  budgetMinutes: Schema.optional(Schema.NullOr(NonNegativeInt)),
  maxConcurrentRuns: Schema.optional(NonNegativeInt),
  exclusions: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});
export type AgentDashboardRepositoryPolicyInput = typeof AgentDashboardRepositoryPolicyInput.Type;

export const AgentDashboardRunInvestigationInput = Schema.Struct({
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type AgentDashboardRunInvestigationInput = typeof AgentDashboardRunInvestigationInput.Type;

export const AgentDashboardRetryRunInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AgentDashboardRetryRunInput = typeof AgentDashboardRetryRunInput.Type;

export const AgentDashboardCollectInput = Schema.Struct({
  kind: AgentDashboardCollectorKind,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type AgentDashboardCollectInput = typeof AgentDashboardCollectInput.Type;

/** A user-managed research source collected for one repository. */
export const AgentDashboardResearchWatchItemInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  category: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type AgentDashboardResearchWatchItemInput = typeof AgentDashboardResearchWatchItemInput.Type;

export class AgentDashboardError extends Schema.TaggedError<AgentDashboardError>()(
  "AgentDashboardError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

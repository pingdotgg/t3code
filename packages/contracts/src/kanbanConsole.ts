import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const KanbanConsoleLocale = Schema.Literals(["en", "ar"]);
export type KanbanConsoleLocale = typeof KanbanConsoleLocale.Type;

export const KanbanColumnId = Schema.Literals([
  "backlog",
  "ready",
  "in-progress",
  "review",
  "blocked",
  "done",
]);
export type KanbanColumnId = typeof KanbanColumnId.Type;

export const KanbanConsolePriority = Schema.Literals(["P0", "P1", "P2"]);
export type KanbanConsolePriority = typeof KanbanConsolePriority.Type;

export const KanbanConsoleAgentKind = Schema.Literals(["Codex", "Claude", "Human"]);
export type KanbanConsoleAgentKind = typeof KanbanConsoleAgentKind.Type;

export const KanbanConsoleRepoStatus = Schema.Literals(["healthy", "attention", "blocked"]);
export type KanbanConsoleRepoStatus = typeof KanbanConsoleRepoStatus.Type;

export const KanbanConsoleCheckStatus = Schema.Literals([
  "passing",
  "pending",
  "failing",
  "skipped",
]);
export type KanbanConsoleCheckStatus = typeof KanbanConsoleCheckStatus.Type;

export const KanbanConsoleReviewSignalKind = Schema.Literals([
  "ci-failure",
  "review-comment",
  "approval",
  "change-request",
]);
export type KanbanConsoleReviewSignalKind = typeof KanbanConsoleReviewSignalKind.Type;

export const KanbanConsoleSuggestedFixStatus = Schema.Literals([
  "eligible",
  "needs-confirmation",
  "blocked",
  "queued",
]);
export type KanbanConsoleSuggestedFixStatus = typeof KanbanConsoleSuggestedFixStatus.Type;

export const KanbanConsoleCommandRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
]);
export type KanbanConsoleCommandRunStatus = typeof KanbanConsoleCommandRunStatus.Type;

export const KanbanConsoleArtifactStatus = Schema.Literals(["clean", "dirty", "conflict"]);
export type KanbanConsoleArtifactStatus = typeof KanbanConsoleArtifactStatus.Type;

export const KanbanConsoleReleaseGateStatus = Schema.Literals(["passing", "pending", "blocked"]);
export type KanbanConsoleReleaseGateStatus = typeof KanbanConsoleReleaseGateStatus.Type;

export const KanbanConsoleTransitionActionKind = Schema.Literals([
  "none",
  "open-action-sheet",
  "queue-agent-workflow",
  "blocked",
]);
export type KanbanConsoleTransitionActionKind = typeof KanbanConsoleTransitionActionKind.Type;

export const KanbanConsolePrWatchHealth = Schema.Literals(["green", "attention", "pending"]);
export type KanbanConsolePrWatchHealth = typeof KanbanConsolePrWatchHealth.Type;

export const KanbanConsoleCheckSummary = Schema.Struct({
  passing: NonNegativeInt,
  pending: NonNegativeInt,
  failing: NonNegativeInt,
});
export type KanbanConsoleCheckSummary = typeof KanbanConsoleCheckSummary.Type;

export const KanbanConsoleManagedRepo = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  owner: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  openPrs: NonNegativeInt,
  activeTasks: NonNegativeInt,
  status: KanbanConsoleRepoStatus,
});
export type KanbanConsoleManagedRepo = typeof KanbanConsoleManagedRepo.Type;

export const KanbanConsoleProjectBoard = Schema.Struct({
  id: TrimmedNonEmptyString,
  owner: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  source: Schema.Literal("github-projects"),
  columns: Schema.Array(KanbanColumnId),
});
export type KanbanConsoleProjectBoard = typeof KanbanConsoleProjectBoard.Type;

export const KanbanConsoleTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  issue: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  titleAr: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  column: KanbanColumnId,
  priority: KanbanConsolePriority,
  assignee: TrimmedNonEmptyString,
  pr: Schema.optional(TrimmedNonEmptyString),
  checks: KanbanConsoleCheckSummary,
  agent: KanbanConsoleAgentKind,
  updated: TrimmedNonEmptyString,
  comments: NonNegativeInt,
});
export type KanbanConsoleTask = typeof KanbanConsoleTask.Type;

export const KanbanConsoleTaskTransitionRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  fromColumn: KanbanColumnId,
  toColumn: KanbanColumnId,
  confirmed: Schema.Boolean,
});
export type KanbanConsoleTaskTransitionRequest = typeof KanbanConsoleTaskTransitionRequest.Type;

export const KanbanConsoleTaskTransitionResult = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  fromColumn: KanbanColumnId,
  toColumn: KanbanColumnId,
  action: KanbanConsoleTransitionActionKind,
  requiresConfirmation: Schema.Boolean,
  duplicateSuppressed: Schema.Boolean,
  message: TrimmedNonEmptyString,
});
export type KanbanConsoleTaskTransitionResult = typeof KanbanConsoleTaskTransitionResult.Type;

export const KanbanConsoleCheckRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: KanbanConsoleCheckStatus,
  url: Schema.optional(TrimmedNonEmptyString),
});
export type KanbanConsoleCheckRun = typeof KanbanConsoleCheckRun.Type;

export const KanbanConsoleReviewSignal = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: KanbanConsoleReviewSignalKind,
  source: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type KanbanConsoleReviewSignal = typeof KanbanConsoleReviewSignal.Type;

export const KanbanConsolePullRequestWatch = Schema.Struct({
  id: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  pr: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  checks: Schema.Array(KanbanConsoleCheckRun),
  reviewSignals: Schema.Array(KanbanConsoleReviewSignal),
  lastSeenAt: IsoDateTime,
});
export type KanbanConsolePullRequestWatch = typeof KanbanConsolePullRequestWatch.Type;

export const KanbanConsoleSuggestedFix = Schema.Struct({
  id: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  prWatchId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  status: KanbanConsoleSuggestedFixStatus,
  guardrails: Schema.Array(TrimmedNonEmptyString),
});
export type KanbanConsoleSuggestedFix = typeof KanbanConsoleSuggestedFix.Type;

export const KanbanConsoleCommandRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  status: KanbanConsoleCommandRunStatus,
  startedAt: Schema.optional(IsoDateTime),
  finishedAt: Schema.optional(IsoDateTime),
});
export type KanbanConsoleCommandRun = typeof KanbanConsoleCommandRun.Type;

export const KanbanConsoleGitFileStatus = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: Schema.Literals(["staged", "unstaged", "untracked"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type KanbanConsoleGitFileStatus = typeof KanbanConsoleGitFileStatus.Type;

export const KanbanConsoleGitStatusSnapshot = Schema.Struct({
  repoId: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstream: Schema.optional(TrimmedNonEmptyString),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  files: Schema.Array(KanbanConsoleGitFileStatus),
});
export type KanbanConsoleGitStatusSnapshot = typeof KanbanConsoleGitStatusSnapshot.Type;

export const KanbanConsoleArtifact = Schema.Struct({
  id: TrimmedNonEmptyString,
  repoId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  status: KanbanConsoleArtifactStatus,
  updatedAt: IsoDateTime,
});
export type KanbanConsoleArtifact = typeof KanbanConsoleArtifact.Type;

export const KanbanConsoleGitOpsPolicy = Schema.Struct({
  protectedBranches: Schema.Array(TrimmedNonEmptyString),
  allowedWorkBranchPrefixes: Schema.Array(TrimmedNonEmptyString),
  destructiveActionsRequireSecondConfirmation: Schema.Boolean,
});
export type KanbanConsoleGitOpsPolicy = typeof KanbanConsoleGitOpsPolicy.Type;

export const KanbanConsoleReleaseReadiness = Schema.Struct({
  branch: TrimmedNonEmptyString,
  gates: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      status: KanbanConsoleReleaseGateStatus,
    }),
  ),
});
export type KanbanConsoleReleaseReadiness = typeof KanbanConsoleReleaseReadiness.Type;

export const KanbanConsoleAgentWorkflow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  agent: KanbanConsoleAgentKind,
  command: TrimmedNonEmptyString,
  available: Schema.Boolean,
});
export type KanbanConsoleAgentWorkflow = typeof KanbanConsoleAgentWorkflow.Type;

export const KanbanConsoleSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoDateTime,
  locale: KanbanConsoleLocale,
  repos: Schema.Array(KanbanConsoleManagedRepo),
  boards: Schema.Array(KanbanConsoleProjectBoard),
  tasks: Schema.Array(KanbanConsoleTask),
  prWatches: Schema.Array(KanbanConsolePullRequestWatch),
  suggestedFixes: Schema.Array(KanbanConsoleSuggestedFix),
  commandRuns: Schema.Array(KanbanConsoleCommandRun),
  gitStatuses: Schema.Array(KanbanConsoleGitStatusSnapshot),
  artifacts: Schema.Array(KanbanConsoleArtifact),
  gitOpsPolicy: KanbanConsoleGitOpsPolicy,
  releaseReadiness: KanbanConsoleReleaseReadiness,
  agentWorkflows: Schema.Array(KanbanConsoleAgentWorkflow),
});
export type KanbanConsoleSnapshot = typeof KanbanConsoleSnapshot.Type;

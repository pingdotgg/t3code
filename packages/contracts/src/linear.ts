import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Linear integration contracts (schema-only). Tracker-neutral naming is avoided on purpose:
 * these are Linear's normalized shapes, produced by `@t3tools/issue-tracker-linear`.
 */

/** Hard cap on issues returned for one list view; the UI shows "Showing first 250". */
const LINEAR_LIST_ISSUE_CAP = 250;

const LinearId = TrimmedNonEmptyString;
const OptionalName = Schema.NullOr(Schema.String);

// ── Errors ────────────────────────────────────────────────────────────────

export const LinearErrorReason = Schema.Literals([
  "not_connected",
  "unauthorized",
  "rate_limited",
  "unavailable",
  "not_found",
  "invalid_input",
]);
export type LinearErrorReason = typeof LinearErrorReason.Type;

export class LinearError extends Schema.TaggedError<LinearError>()("LinearError", {
  reason: LinearErrorReason,
  message: Schema.String,
  retryAfterSeconds: Schema.optional(NonNegativeInt),
}) {}

// ── Connection ────────────────────────────────────────────────────────────

export const LinearViewer = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  email: Schema.String,
  avatarUrl: OptionalName,
});
export type LinearViewer = typeof LinearViewer.Type;

export const LinearOrganization = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  urlKey: Schema.String,
});
export type LinearOrganization = typeof LinearOrganization.Type;

export const LinearTeam = Schema.Struct({
  id: LinearId,
  key: Schema.String,
  name: Schema.String,
  description: OptionalName,
  color: OptionalName,
  icon: OptionalName,
  projectCount: NonNegativeInt,
  /** Open issues assigned to the viewer in this team. */
  assignedToViewerCount: NonNegativeInt,
});
export type LinearTeam = typeof LinearTeam.Type;

export const LinearConnectionState = Schema.Literals(["disconnected", "connected", "invalid"]);
export type LinearConnectionState = typeof LinearConnectionState.Type;

/** What clients may know about the connection. The key itself never leaves the server. */
export const LinearConnectionStatus = Schema.Struct({
  state: LinearConnectionState,
  method: Schema.NullOr(Schema.Literal("api-key")),
  organization: Schema.NullOr(LinearOrganization),
  viewer: Schema.NullOr(LinearViewer),
  teams: Schema.Array(LinearTeam),
  /** Set while Linear is rate limiting this server; the UI shows a cached-data banner. */
  rateLimitedUntil: Schema.NullOr(IsoDateTime),
});
export type LinearConnectionStatus = typeof LinearConnectionStatus.Type;

export const LinearConnectInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type LinearConnectInput = typeof LinearConnectInput.Type;

// ── Domain ────────────────────────────────────────────────────────────────

export const LinearStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
export type LinearStateType = typeof LinearStateType.Type;

export const LinearWorkflowState = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  type: LinearStateType,
  color: Schema.String,
  position: Schema.Number,
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

export const LinearLabel = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  color: Schema.String,
});
export type LinearLabel = typeof LinearLabel.Type;

export const LinearUserRef = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  avatarUrl: OptionalName,
});
export type LinearUserRef = typeof LinearUserRef.Type;

export const LinearCycle = Schema.Struct({
  id: LinearId,
  number: NonNegativeInt,
  name: OptionalName,
  startsAt: Schema.NullOr(IsoDateTime),
  endsAt: Schema.NullOr(IsoDateTime),
  isCurrent: Schema.Boolean,
  isNext: Schema.Boolean,
});
export type LinearCycle = typeof LinearCycle.Type;

export const LinearTeamMetadata = Schema.Struct({
  teamId: LinearId,
  states: Schema.Array(LinearWorkflowState),
  labels: Schema.Array(LinearLabel),
  cycles: Schema.Array(LinearCycle),
  members: Schema.Array(LinearUserRef),
});
export type LinearTeamMetadata = typeof LinearTeamMetadata.Type;

export const LinearProjectStatus = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  color: OptionalName,
});
export type LinearProjectStatus = typeof LinearProjectStatus.Type;

export const LinearProject = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  status: LinearProjectStatus,
  /** 0..1 */
  progress: Schema.Number,
  targetDate: Schema.NullOr(Schema.String),
  teamIds: Schema.Array(LinearId),
  url: Schema.String,
});
export type LinearProject = typeof LinearProject.Type;

export const LinearMilestone = Schema.Struct({
  id: LinearId,
  projectId: LinearId,
  name: Schema.String,
  /** 0..1 */
  progress: Schema.Number,
  targetDate: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
  /** progress = 1 or done. */
  completed: Schema.Boolean,
  issueCount: NonNegativeInt,
});
export type LinearMilestone = typeof LinearMilestone.Type;

export const LinearPriority = Schema.Literals([0, 1, 2, 3, 4]);
export type LinearPriority = typeof LinearPriority.Type;

export const LinearLinkedPullRequest = Schema.Struct({
  /** `owner/repo` when parseable from the attachment URL. */
  repository: Schema.NullOr(Schema.String),
  number: Schema.Number,
  state: Schema.NullOr(Schema.String),
  url: Schema.String,
});
export type LinearLinkedPullRequest = typeof LinearLinkedPullRequest.Type;

export const LinearIssueState = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  type: LinearStateType,
  color: Schema.String,
});
export type LinearIssueState = typeof LinearIssueState.Type;

export const LinearIssue = Schema.Struct({
  id: LinearId,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  state: LinearIssueState,
  priority: LinearPriority,
  priorityLabel: Schema.String,
  assignee: Schema.NullOr(LinearUserRef),
  labels: Schema.Array(LinearLabel),
  cycle: Schema.NullOr(Schema.Struct({ id: LinearId, number: NonNegativeInt })),
  milestone: Schema.NullOr(Schema.Struct({ id: LinearId, name: Schema.String })),
  project: Schema.NullOr(Schema.Struct({ id: LinearId, name: Schema.String })),
  team: Schema.Struct({ id: LinearId, key: Schema.String, name: Schema.String }),
  parent: Schema.NullOr(Schema.Struct({ id: LinearId, identifier: Schema.String })),
  subIssueCount: NonNegativeInt,
  completedSubIssueCount: NonNegativeInt,
  branchName: Schema.String,
  updatedAt: IsoDateTime,
  linkedPullRequests: Schema.Array(LinearLinkedPullRequest),
});
export type LinearIssue = typeof LinearIssue.Type;

export const LinearComment = Schema.Struct({
  id: LinearId,
  author: Schema.NullOr(LinearUserRef),
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type LinearComment = typeof LinearComment.Type;

export const LinearAttachment = Schema.Struct({
  id: LinearId,
  title: Schema.String,
  url: Schema.String,
  sourceType: Schema.NullOr(Schema.String),
});
export type LinearAttachment = typeof LinearAttachment.Type;

export const LinearIssueDetail = Schema.Struct({
  issue: LinearIssue,
  description: Schema.String,
  milestoneProgress: Schema.NullOr(Schema.Number),
  subIssues: Schema.Array(LinearIssue),
  /** Last 20, oldest → newest. */
  comments: Schema.Array(LinearComment),
  attachments: Schema.Array(LinearAttachment),
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

export const LinearCustomView = Schema.Struct({
  id: LinearId,
  name: Schema.String,
  description: OptionalName,
  filterDescription: OptionalName,
});
export type LinearCustomView = typeof LinearCustomView.Type;

// ── Queries ───────────────────────────────────────────────────────────────

export const LinearIssueFilter = Schema.Struct({
  teamId: Schema.optional(LinearId),
  projectId: Schema.optional(LinearId),
  /** `"none"` selects issues without a milestone. */
  milestoneId: Schema.optional(LinearId),
  /** `"me"` or a user id. Omitted = anyone. */
  assignee: Schema.optional(LinearId),
  stateIds: Schema.optional(Schema.Array(LinearId)),
  stateTypes: Schema.optional(Schema.Array(LinearStateType)),
  priorities: Schema.optional(Schema.Array(LinearPriority)),
  labelIds: Schema.optional(Schema.Array(LinearId)),
  cycleId: Schema.optional(LinearId),
  /** Title search. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** Include completed/canceled issues. Default false. */
  includeCompleted: Schema.optional(Schema.Boolean),
  /** Custom view whose own filter applies instead of the fields above. */
  viewId: Schema.optional(LinearId),
  /** Restrict to these ids (used for "Has T3 activity"). */
  issueIds: Schema.optional(
    Schema.Array(LinearId).check(Schema.isMaxLength(LINEAR_LIST_ISSUE_CAP)),
  ),
});
export type LinearIssueFilter = typeof LinearIssueFilter.Type;

export const LinearIssueListResult = Schema.Struct({
  issues: Schema.Array(LinearIssue),
  /** True when the 250-issue cap cut the list. */
  truncated: Schema.Boolean,
  fetchedAt: IsoDateTime,
  /** True when served from cache because Linear failed or rate limited. */
  stale: Schema.Boolean,
});
export type LinearIssueListResult = typeof LinearIssueListResult.Type;

export const LinearTeamIdInput = Schema.Struct({ teamId: LinearId });
export const LinearProjectsInput = Schema.Struct({ teamId: Schema.optional(LinearId) });
export const LinearMilestonesInput = Schema.Struct({ projectId: LinearId });
export const LinearIssueIdInput = Schema.Struct({ issueId: LinearId });
export const LinearSearchInput = Schema.Struct({
  term: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export const LinearViewIssuesInput = Schema.Struct({ viewId: LinearId });

// ── T3 links & activity ───────────────────────────────────────────────────

export const LinearLinkTargetKind = Schema.Literals(["thread", "pipeline_run"]);
export type LinearLinkTargetKind = typeof LinearLinkTargetKind.Type;

export const LinearCommentMode = Schema.Literals(["none", "thread", "pipeline"]);
export type LinearCommentMode = typeof LinearCommentMode.Type;

export const LinearIssueLink = Schema.Struct({
  linkId: LinearId,
  issueId: LinearId,
  issueIdentifier: Schema.String,
  teamId: LinearId,
  projectId: Schema.NullOr(LinearId),
  targetKind: LinearLinkTargetKind,
  targetId: LinearId,
  /** For pipeline runs: the run's parent thread. */
  threadId: ThreadId,
  createdAt: IsoDateTime,
  commentId: Schema.NullOr(Schema.String),
  commentMode: LinearCommentMode,
  stateMovedTo: Schema.NullOr(Schema.String),
});
export type LinearIssueLink = typeof LinearIssueLink.Type;

export const LinearActivityStatus = Schema.Literals([
  "running",
  "idle",
  "completed",
  "failed",
  "paused",
  "cancelled",
]);
export type LinearActivityStatus = typeof LinearActivityStatus.Type;

export const LinearActivityItem = Schema.Struct({
  link: LinearIssueLink,
  title: Schema.String,
  /** Thread provider, e.g. "codex"; null for pipeline runs. */
  provider: Schema.NullOr(Schema.String),
  messageCount: Schema.NullOr(NonNegativeInt),
  status: LinearActivityStatus,
  updatedAt: IsoDateTime,
  pipeline: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      steps: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: Schema.Literals([
            "pending",
            "running",
            "completed",
            "failed",
            "stopped",
            "skipped",
            "cancelled",
          ]),
        }),
      ),
      currentStepName: Schema.NullOr(Schema.String),
      failedStepName: Schema.NullOr(Schema.String),
    }),
  ),
});
export type LinearActivityItem = typeof LinearActivityItem.Type;

export const LinearIssueActivity = Schema.Struct({
  issueId: LinearId,
  issueIdentifier: Schema.String,
  teamId: LinearId,
  items: Schema.Array(LinearActivityItem),
  latestActivityAt: IsoDateTime,
  runningCount: NonNegativeInt,
  threadCount: NonNegativeInt,
  pipelineRunning: Schema.Boolean,
  pipelineFailed: Schema.Boolean,
});
export type LinearIssueActivity = typeof LinearIssueActivity.Type;

/** All issues with T3 links (small: bounded by user activity). */
export const LinearActivityResult = Schema.Struct({
  issues: Schema.Array(LinearIssueActivity),
});
export type LinearActivityResult = typeof LinearActivityResult.Type;

export const LinearLaunchTarget = Schema.Struct({
  kind: LinearLinkTargetKind,
  /** Thread id, or pipeline run id. */
  targetId: LinearId,
  /** The thread (or pipeline parent thread) the launch created. */
  threadId: ThreadId,
  title: Schema.String,
});
export type LinearLaunchTarget = typeof LinearLaunchTarget.Type;

export const LinearRecordLaunchInput = Schema.Struct({
  issueId: LinearId,
  target: LinearLaunchTarget,
  writeBack: Schema.Struct({
    moveToStateId: Schema.optional(LinearId),
    comment: Schema.Boolean,
  }),
  /** `<origin>/<environmentId>/<threadId>` of the launching client. */
  threadUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type LinearRecordLaunchInput = typeof LinearRecordLaunchInput.Type;

export const LinearWriteBackWarning = Schema.Struct({
  step: Schema.Literals(["move_state", "comment"]),
  message: Schema.String,
});

export const LinearRecordLaunchResult = Schema.Struct({
  link: LinearIssueLink,
  warnings: Schema.Array(LinearWriteBackWarning),
});
export type LinearRecordLaunchResult = typeof LinearRecordLaunchResult.Type;

// ── Settings fragments (the section itself lives in settings.ts) ──────────

export const LinearMappingKind = Schema.Literals(["team", "project"]);
export type LinearMappingKind = typeof LinearMappingKind.Type;

export const LinearMapping = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  kind: LinearMappingKind,
  /** Linear team id or project id. */
  linearId: LinearId,
  /** Display only; refreshed when edited. */
  linearName: Schema.String,
  projectId: ProjectId,
  baseBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
});
export type LinearMapping = typeof LinearMapping.Type;

export const LinearDefaultWorkspace = Schema.Literals(["worktree", "local"]);
export type LinearDefaultWorkspace = typeof LinearDefaultWorkspace.Type;

import * as Schema from "effect/Schema";
import { PositiveInt, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const LINEAR_SEARCH_MAX_LIMIT = 50;
const LINEAR_LIST_MAX_LIMIT = 100;
const LINEAR_SEARCH_QUERY_MAX_LENGTH = 256;
const LINEAR_TOKEN_MAX_LENGTH = 512;

// ── Auth status ──────────────────────────────────────────────────────

export const LinearAuthStatusValue = Schema.Literals(["authenticated", "unauthenticated"]);
export type LinearAuthStatusValue = typeof LinearAuthStatusValue.Type;

export const LinearAccount = Schema.Struct({
  name: TrimmedNonEmptyString,
  email: Schema.optional(TrimmedNonEmptyString),
});
export type LinearAccount = typeof LinearAccount.Type;

export const LinearAuthStatus = Schema.Struct({
  status: LinearAuthStatusValue,
  account: Schema.optional(LinearAccount),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type LinearAuthStatus = typeof LinearAuthStatus.Type;

// ── Workflow states ──────────────────────────────────────────────────

/** Linear workflow-state category. Stable across teams that rename states. */
export const LinearWorkflowStateType = Schema.Literals([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "triage",
]);
export type LinearWorkflowStateType = typeof LinearWorkflowStateType.Type;

// ── Issue shapes ─────────────────────────────────────────────────────

export const LinearIssueSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  stateName: Schema.optional(TrimmedNonEmptyString),
  stateType: Schema.optional(LinearWorkflowStateType),
  priorityLabel: Schema.optional(TrimmedNonEmptyString),
  assigneeName: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  teamId: Schema.optional(TrimmedNonEmptyString),
});
export type LinearIssueSummary = typeof LinearIssueSummary.Type;

export const LinearSubIssue = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  stateName: Schema.optional(TrimmedNonEmptyString),
});
export type LinearSubIssue = typeof LinearSubIssue.Type;

export const LinearLinkedPullRequest = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(TrimmedNonEmptyString),
});
export type LinearLinkedPullRequest = typeof LinearLinkedPullRequest.Type;

export const LinearComment = Schema.Struct({
  author: Schema.optional(TrimmedNonEmptyString),
  body: Schema.String,
  createdAt: Schema.optional(TrimmedNonEmptyString),
});
export type LinearComment = typeof LinearComment.Type;

export const LinearAttachment = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  url: Schema.String,
});
export type LinearAttachment = typeof LinearAttachment.Type;

export const LinearIssueDetail = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  stateName: Schema.optional(TrimmedNonEmptyString),
  stateType: Schema.optional(LinearWorkflowStateType),
  priorityLabel: Schema.optional(TrimmedNonEmptyString),
  assigneeName: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  teamId: Schema.optional(TrimmedNonEmptyString),
  description: Schema.String,
  labels: Schema.Array(TrimmedNonEmptyString),
  subIssues: Schema.Array(LinearSubIssue),
  linkedPullRequests: Schema.Array(LinearLinkedPullRequest),
  attachments: Schema.Array(LinearAttachment),
  comments: Schema.Array(LinearComment),
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

// ── Filter metadata (teams / states / projects / labels / users) ─────

export const LinearTeam = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type LinearTeam = typeof LinearTeam.Type;

export const LinearWorkflowState = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  type: LinearWorkflowStateType,
  position: Schema.Number,
  color: Schema.optional(TrimmedNonEmptyString),
  teamId: Schema.optional(TrimmedNonEmptyString),
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

export const LinearProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type LinearProject = typeof LinearProject.Type;

export const LinearLabel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  color: Schema.optional(TrimmedNonEmptyString),
});
export type LinearLabel = typeof LinearLabel.Type;

export const LinearUser = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  isMe: Schema.optional(Schema.Boolean),
});
export type LinearUser = typeof LinearUser.Type;

/** Persisted link from a T3 Code thread back to the Linear issue it came from. */
export const LinearIssueLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  teamId: Schema.optional(TrimmedNonEmptyString),
  stateType: Schema.optional(LinearWorkflowStateType),
  stateName: Schema.optional(TrimmedNonEmptyString),
});
export type LinearIssueLink = typeof LinearIssueLink.Type;

// ── Filter + pagination ──────────────────────────────────────────────

export const LinearIssueFilter = Schema.Struct({
  teamId: Schema.optional(TrimmedNonEmptyString),
  assigneeId: Schema.optional(TrimmedNonEmptyString),
  stateType: Schema.optional(LinearWorkflowStateType),
  stateId: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(TrimmedNonEmptyString),
  labelId: Schema.optional(TrimmedNonEmptyString),
  priority: Schema.optional(Schema.Int),
  query: Schema.optional(TrimmedString.check(Schema.isMaxLength(LINEAR_SEARCH_QUERY_MAX_LENGTH))),
});
export type LinearIssueFilter = typeof LinearIssueFilter.Type;

export const LinearPageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.optional(TrimmedNonEmptyString),
});
export type LinearPageInfo = typeof LinearPageInfo.Type;

// ── RPC inputs / results ─────────────────────────────────────────────

export const LinearListIssuesInput = Schema.Struct({
  filter: Schema.optional(LinearIssueFilter),
  first: PositiveInt.check(Schema.isLessThanOrEqualTo(LINEAR_LIST_MAX_LIMIT)),
  after: Schema.optional(TrimmedNonEmptyString),
});
export type LinearListIssuesInput = typeof LinearListIssuesInput.Type;

export const LinearListIssuesResult = Schema.Struct({
  issues: Schema.Array(LinearIssueSummary),
  pageInfo: LinearPageInfo,
});
export type LinearListIssuesResult = typeof LinearListIssuesResult.Type;

export const LinearListTeamsResult = Schema.Struct({ teams: Schema.Array(LinearTeam) });
export type LinearListTeamsResult = typeof LinearListTeamsResult.Type;

export const LinearListWorkflowStatesInput = Schema.Struct({ teamId: TrimmedNonEmptyString });
export type LinearListWorkflowStatesInput = typeof LinearListWorkflowStatesInput.Type;

export const LinearListWorkflowStatesResult = Schema.Struct({
  states: Schema.Array(LinearWorkflowState),
});
export type LinearListWorkflowStatesResult = typeof LinearListWorkflowStatesResult.Type;

export const LinearListProjectsResult = Schema.Struct({ projects: Schema.Array(LinearProject) });
export type LinearListProjectsResult = typeof LinearListProjectsResult.Type;

export const LinearListLabelsResult = Schema.Struct({ labels: Schema.Array(LinearLabel) });
export type LinearListLabelsResult = typeof LinearListLabelsResult.Type;

export const LinearListUsersResult = Schema.Struct({ users: Schema.Array(LinearUser) });
export type LinearListUsersResult = typeof LinearListUsersResult.Type;

// ── Write mutations (Phase 3) ────────────────────────────────────────

export const LinearUpdateIssueStateInput = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  stateId: TrimmedNonEmptyString,
});
export type LinearUpdateIssueStateInput = typeof LinearUpdateIssueStateInput.Type;

export const LinearCreateCommentInput = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  body: Schema.String,
});
export type LinearCreateCommentInput = typeof LinearCreateCommentInput.Type;

export const LinearCreateAttachmentInput = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  url: Schema.String,
  title: Schema.optional(TrimmedNonEmptyString),
  subtitle: Schema.optional(TrimmedNonEmptyString),
});
export type LinearCreateAttachmentInput = typeof LinearCreateAttachmentInput.Type;

export const LinearMutationResult = Schema.Struct({ success: Schema.Boolean });
export type LinearMutationResult = typeof LinearMutationResult.Type;

/** Mark the Linear issue linked to a thread as done (right-click → thread menu). */
export const LinearCompleteIssueInput = Schema.Struct({ threadId: ThreadId });
export type LinearCompleteIssueInput = typeof LinearCompleteIssueInput.Type;

export const LinearSearchIssuesInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMaxLength(LINEAR_SEARCH_QUERY_MAX_LENGTH)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(LINEAR_SEARCH_MAX_LIMIT)),
});
export type LinearSearchIssuesInput = typeof LinearSearchIssuesInput.Type;

export const LinearSearchIssuesResult = Schema.Struct({
  issues: Schema.Array(LinearIssueSummary),
  truncated: Schema.Boolean,
});
export type LinearSearchIssuesResult = typeof LinearSearchIssuesResult.Type;

export const LinearFetchIssuesInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString),
});
export type LinearFetchIssuesInput = typeof LinearFetchIssuesInput.Type;

export const LinearFetchIssuesResult = Schema.Struct({
  issues: Schema.Array(LinearIssueDetail),
});
export type LinearFetchIssuesResult = typeof LinearFetchIssuesResult.Type;

export const LinearSetTokenInput = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(LINEAR_TOKEN_MAX_LENGTH)),
});
export type LinearSetTokenInput = typeof LinearSetTokenInput.Type;

// ── Errors ───────────────────────────────────────────────────────────

export const LinearApiOperation = Schema.Literals([
  "probeAuth",
  "searchIssues",
  "fetchIssues",
  "listIssues",
  "listTeams",
  "listWorkflowStates",
  "listProjects",
  "listLabels",
  "listUsers",
  "updateIssueState",
  "createComment",
  "createAttachment",
  "setToken",
  "clearToken",
]);
export type LinearApiOperation = typeof LinearApiOperation.Type;

export class LinearAuthError extends Schema.TaggedErrorClass<LinearAuthError>()("LinearAuthError", {
  operation: LinearApiOperation,
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const suffix = this.detail === undefined ? "" : ` ${this.detail}`;
    return `Linear authentication required for ${this.operation}.${suffix}`;
  }
}

export class LinearRequestError extends Schema.TaggedErrorClass<LinearRequestError>()(
  "LinearRequestError",
  {
    operation: LinearApiOperation,
    status: Schema.optional(Schema.Int),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: ${this.detail}`;
  }
}

export class LinearTokenStoreError extends Schema.TaggedErrorClass<LinearTokenStoreError>()(
  "LinearTokenStoreError",
  {
    operation: LinearApiOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Linear token storage failed in ${this.operation}: ${this.detail}`;
  }
}

export const LinearError = Schema.Union([
  LinearAuthError,
  LinearRequestError,
  LinearTokenStoreError,
]);
export type LinearError = typeof LinearError.Type;
export const isLinearError = Schema.is(LinearError);

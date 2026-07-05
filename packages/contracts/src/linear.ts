import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const LINEAR_SEARCH_MAX_LIMIT = 50;
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

// ── Issue shapes ─────────────────────────────────────────────────────

export const LinearIssueSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  stateName: Schema.optional(TrimmedNonEmptyString),
  priorityLabel: Schema.optional(TrimmedNonEmptyString),
  assigneeName: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
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
  priorityLabel: Schema.optional(TrimmedNonEmptyString),
  assigneeName: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  description: Schema.String,
  labels: Schema.Array(TrimmedNonEmptyString),
  subIssues: Schema.Array(LinearSubIssue),
  linkedPullRequests: Schema.Array(LinearLinkedPullRequest),
  attachments: Schema.Array(LinearAttachment),
  comments: Schema.Array(LinearComment),
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

// ── RPC inputs / results ─────────────────────────────────────────────

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

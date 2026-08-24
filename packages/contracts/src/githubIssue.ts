import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const GitHubIssueState = Schema.Literals(["open", "closed"]);
export type GitHubIssueState = typeof GitHubIssueState.Type;

export const GitHubIssueListState = Schema.Literals(["all", "open", "closed"]);
export type GitHubIssueListState = typeof GitHubIssueListState.Type;

export const GitHubIssueActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type GitHubIssueActor = typeof GitHubIssueActor.Type;

export const GitHubIssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type GitHubIssueLabel = typeof GitHubIssueLabel.Type;

export const GitHubIssueListEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(GitHubIssueActor),
  assignees: Schema.Array(GitHubIssueActor),
  labels: Schema.Array(GitHubIssueLabel),
  state: GitHubIssueState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GitHubIssueListEntry = typeof GitHubIssueListEntry.Type;

export const GitHubIssueListInput = Schema.Struct({
  state: GitHubIssueListState,
  projectId: Schema.optional(ProjectId),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type GitHubIssueListInput = typeof GitHubIssueListInput.Type;

export const GitHubIssueListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type GitHubIssueListProjectError = typeof GitHubIssueListProjectError.Type;

export const GitHubIssueListResult = Schema.Struct({
  entries: Schema.Array(GitHubIssueListEntry),
  errors: Schema.Array(GitHubIssueListProjectError),
  truncated: Schema.Boolean,
});
export type GitHubIssueListResult = typeof GitHubIssueListResult.Type;

export const GitHubIssueRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type GitHubIssueRef = typeof GitHubIssueRef.Type;

export const GitHubIssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(GitHubIssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  url: TrimmedNonEmptyString,
});
export type GitHubIssueComment = typeof GitHubIssueComment.Type;

export const GitHubIssueDetail = Schema.Struct({
  ...GitHubIssueListEntry.fields,
  workspaceRoot: TrimmedNonEmptyString,
  body: Schema.String,
  comments: Schema.Array(GitHubIssueComment),
  commentCount: NonNegativeInt,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type GitHubIssueDetail = typeof GitHubIssueDetail.Type;

export class GitHubIssueUnavailableError extends Schema.TaggedErrorClass<GitHubIssueUnavailableError>()(
  "GitHubIssueUnavailableError",
  {
    reason: Schema.Literals(["cli-missing", "cli-unauthenticated"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "cli-missing"
      ? "GitHub CLI (`gh`) is required to browse issues. Install it from https://cli.github.com/ and reload."
      : "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }
}

export class GitHubIssueOperationError extends Schema.TaggedErrorClass<GitHubIssueOperationError>()(
  "GitHubIssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub issue operation ${this.operation} failed: ${this.detail}`;
  }
}

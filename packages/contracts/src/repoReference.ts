import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  PullRequestOperationError,
  PullRequestState,
  PullRequestUnavailableError,
} from "./pullRequest.ts";

export const RepoReferenceKind = Schema.Literals(["pull-request", "issue", "discussion"]);
export type RepoReferenceKind = typeof RepoReferenceKind.Type;

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

export const DiscussionState = Schema.Literals(["open", "closed"]);
export type DiscussionState = typeof DiscussionState.Type;

const RepoReferenceBase = {
  kind: RepoReferenceKind,
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
} as const;

export const RepoReferencePullRequest = Schema.Struct({
  ...RepoReferenceBase,
  kind: Schema.Literal("pull-request"),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
});
export type RepoReferencePullRequest = typeof RepoReferencePullRequest.Type;

export const RepoReferenceIssue = Schema.Struct({
  ...RepoReferenceBase,
  kind: Schema.Literal("issue"),
  state: IssueState,
});
export type RepoReferenceIssue = typeof RepoReferenceIssue.Type;

export const RepoReferenceDiscussion = Schema.Struct({
  ...RepoReferenceBase,
  kind: Schema.Literal("discussion"),
  state: DiscussionState,
  category: Schema.optional(TrimmedNonEmptyString),
});
export type RepoReferenceDiscussion = typeof RepoReferenceDiscussion.Type;

export const RepoReferenceEntry = Schema.Union([
  RepoReferencePullRequest,
  RepoReferenceIssue,
  RepoReferenceDiscussion,
]);
export type RepoReferenceEntry = typeof RepoReferenceEntry.Type;

export const RepoReferenceSearchInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type RepoReferenceSearchInput = typeof RepoReferenceSearchInput.Type;

export const RepoReferenceSearchResult = Schema.Struct({
  entries: Schema.Array(RepoReferenceEntry),
  /** Partial provider failures; other reference kinds may still be present. */
  errors: Schema.Array(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type RepoReferenceSearchResult = typeof RepoReferenceSearchResult.Type;

export const RepoReferenceSearchError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);
export type RepoReferenceSearchError = typeof RepoReferenceSearchError.Type;

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * GitHub Issues from the repositories of an environment's projects, read live from GitHub and
 * never stored. GitHub only: other forges are reported as not supported.
 */

/** GitHub's own state: closed as completed is Done, as not planned or duplicate Not planned. */
export const IssueState = Schema.Literals(["open", "done", "not-planned"]);
export type IssueState = typeof IssueState.Type;

export const IssueListState = Schema.Literals(["open", "closed", "all"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueListSort = Schema.Literals(["updated", "created", "number"]);
export type IssueListSort = typeof IssueListSort.Type;

/** Addresses one Issue. The server runs `gh` in any checkout on `host`. */
export const IssueRef = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueRef = typeof IssueRef.Type;

/** A parent or sub-Issue as the list shows it, possibly in a repository outside the projects. */
export const IssueLink = Schema.Struct({
  ...IssueRef.fields,
  title: Schema.String,
  url: TrimmedNonEmptyString,
  state: IssueState,
});
export type IssueLink = typeof IssueLink.Type;

export const IssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.String,
});
export type IssueLabel = typeof IssueLabel.Type;

/**
 * The commit status `review/independent` on a pull request's head. `error` reads as a failure,
 * `expected` as pending. Clients count it only when a trusted account posted it: the account
 * behind the GitHub connection of any server that listed the Issue.
 */
export const IssueReviewMark = Schema.Literals(["pending", "success", "failure"]);
export type IssueReviewMark = typeof IssueReviewMark.Type;

export const IssueReviewStatus = Schema.Struct({
  state: IssueReviewMark,
  /** Login of the account that posted it; null for a deleted account. */
  creator: Schema.NullOr(Schema.String),
});
export type IssueReviewStatus = typeof IssueReviewStatus.Type;

/**
 * A pull request as the list's own GraphQL page reads it: one that closes the Issue
 * (`Closes #N`), or one linked to a thread of this server.
 */
export const IssuePullRequest = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  review: Schema.NullOr(IssueReviewStatus),
});
export type IssuePullRequest = typeof IssuePullRequest.Type;

export const IssueListEntry = Schema.Struct({
  ...IssueLink.fields,
  /** The project whose repository this is; worktrees of one repository list it once. */
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  author: Schema.NullOr(TrimmedNonEmptyString),
  labels: Schema.Array(IssueLabel),
  milestone: Schema.NullOr(TrimmedNonEmptyString),
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  parent: Schema.NullOr(IssueLink),
  subIssues: Schema.Array(IssueLink),
  /** GitHub's own count, which can exceed `subIssues` when there are more than one page. */
  subIssueCount: NonNegativeInt,
  /** Native blockers (`blocked by`) still open. */
  openBlockerCount: NonNegativeInt,
  /** Open, closed and merged alike; closed ones still derive thread links. */
  closingPullRequests: Schema.Array(IssuePullRequest),
});
export type IssueListEntry = typeof IssueListEntry.Type;

/** Opaque per-search continuation, keyed by the search it came from. */
export const IssueListCursors = Schema.Record(
  TrimmedNonEmptyString,
  TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
);
export type IssueListCursors = typeof IssueListCursors.Type;

const BoundedText = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

export const IssueListInput = Schema.Struct({
  state: IssueListState,
  sort: Schema.optional(IssueListSort),
  /** Free text GitHub matches, quoted so it cannot become a qualifier. */
  query: Schema.optional(BoundedText),
  /** Every label must be present. */
  labels: Schema.optional(Schema.Array(BoundedText).check(Schema.isMaxLength(10))),
  milestone: Schema.optional(BoundedText),
  /** Only these repositories, as `<host> <owner/name>`; absent means every project repository. */
  repositories: Schema.optional(Schema.Array(BoundedText).check(Schema.isMaxLength(100))),
  /** Rows per search page. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  /** Carry on from `nextCursors`; only the searches named here are read. */
  cursors: Schema.optional(IssueListCursors),
});
export type IssueListInput = typeof IssueListInput.Type;

export const IssueListRepository = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
});
export type IssueListRepository = typeof IssueListRepository.Type;

export const IssueListResult = Schema.Struct({
  /** Every GitHub repository of this environment's projects, whether or not it has rows. */
  repositories: Schema.Array(IssueListRepository),
  /** Repositories on forges other than GitHub, which this view does not read; once each. */
  unsupported: Schema.Array(
    Schema.Struct({ host: TrimmedNonEmptyString, repository: TrimmedNonEmptyString }),
  ),
  /** Hosts whose search failed; the others still answer. */
  errors: Schema.Array(Schema.Struct({ host: TrimmedNonEmptyString, message: Schema.String })),
  entries: Schema.Array(IssueListEntry),
  /** The account each host's reads ran as; review marks it posted are trusted. */
  viewers: Schema.Array(Schema.Struct({ host: TrimmedNonEmptyString, login: Schema.String })),
  /**
   * Open pull requests linked to this server's threads, read on each search's first page. GitHub
   * makes closing references only for pull requests into the default branch, so a component
   * pull request into another branch reaches its Issue through its thread instead.
   */
  linkedPullRequests: Schema.Array(IssuePullRequest),
  /** Where each search carries on; absent once it has nothing more. */
  nextCursors: IssueListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: TrimmedNonEmptyString,
});
export type IssueComment = typeof IssueComment.Type;

export const IssueDetail = Schema.Struct({
  ...IssueLink.fields,
  author: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The newest comments, oldest first. */
  comments: Schema.Array(IssueComment),
  commentCount: NonNegativeInt,
  /** Locked Issues take comments from collaborators only; GitHub decides and says why. */
  locked: Schema.Boolean,
  viewerCanClose: Schema.Boolean,
  viewerCanReopen: Schema.Boolean,
  /** As on the list's rows, so the side panel shows them however it was opened. */
  closingPullRequests: Schema.Array(IssuePullRequest),
});
export type IssueDetail = typeof IssueDetail.Type;

// Markdown is not trimmed; GitHub refuses bodies past 65536 characters.
export const IssueCommentInput = Schema.Struct({
  ...IssueRef.fields,
  body: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type IssueCommentInput = typeof IssueCommentInput.Type;

export const IssueStateAction = Schema.Literals(["close-completed", "close-not-planned", "reopen"]);
export type IssueStateAction = typeof IssueStateAction.Type;

export const IssueSetStateInput = Schema.Struct({
  ...IssueRef.fields,
  action: IssueStateAction,
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ISSUE_WS_METHODS = {
  issuesList: "issues.list",
  issuesDetail: "issues.detail",
  issuesComment: "issues.comment",
  issuesSetState: "issues.setState",
} as const;

const IssueRpcError = Schema.Union([IssueOperationError, EnvironmentAuthorizationError]);

export const IssueRpcs = [
  Rpc.make(ISSUE_WS_METHODS.issuesList, {
    payload: IssueListInput,
    success: IssueListResult,
    error: IssueRpcError,
  }),
  Rpc.make(ISSUE_WS_METHODS.issuesDetail, {
    payload: IssueRef,
    success: IssueDetail,
    error: IssueRpcError,
  }),
  Rpc.make(ISSUE_WS_METHODS.issuesComment, {
    payload: IssueCommentInput,
    success: Schema.Void,
    error: IssueRpcError,
  }),
  Rpc.make(ISSUE_WS_METHODS.issuesSetState, {
    payload: IssueSetStateInput,
    success: Schema.Void,
    error: IssueRpcError,
  }),
] as const;

export * from "./issueStatus.ts";

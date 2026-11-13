import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";
import { PullRequestAction, PullRequestActor, PullRequestBaseComparison, PullRequestCapabilities, PullRequestCheck, PullRequestChecksState, PullRequestComment, PullRequestCommit, PullRequestDiffSide, PullRequestLabel, PullRequestListInput, PullRequestMergeCapabilities, PullRequestMergeMethod, PullRequestMergeability, PullRequestReaction, PullRequestReactionContent, PullRequestRef, PullRequestReviewDecision, PullRequestReviewThread, PullRequestReviewVerdict, PullRequestReviewerKind, PullRequestStackMembership, PullRequestState, PullRequestThreadComment, PullRequestUpdateMethod, PullRequestViewerPermissions } from "./pullRequestPart2.ts";
export {
  PullRequestAction,
  PullRequestActor,
  PullRequestBaseComparison,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDiffSide,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestLabelCandidate,
  PullRequestLabelCandidateList,
  PullRequestLinkedThreadsResult,
  PullRequestListCursors,
  PullRequestListEntry,
  PullRequestListFilters,
  PullRequestListInput,
  PullRequestListProjectError,
  PullRequestListResult,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestPreview,
  PullRequestProviderSummary,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestRef,
  PullRequestReviewCapabilities,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
  PullRequestReviewerCapabilities,
  PullRequestReviewerKind,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestRoutingResult,
  PullRequestStackMembership,
  PullRequestState,
  PullRequestThreadComment,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
} from "./pullRequestPart2.ts";

export const PullRequestSummary = Schema.Struct({
  provider: SourceControlProviderKind,
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.optional(Schema.Boolean),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: IsoDateTime,
  observedAt: Schema.optional(Schema.Finite),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
  /** Null when the host says the pull request is in no stack; absent when the read did not ask. */
  stack: Schema.optional(Schema.NullOr(PullRequestStackMembership)),
});
export type PullRequestSummary = typeof PullRequestSummary.Type;

export const PullRequestStack = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      title: Schema.optional(Schema.String),
      isDraft: Schema.optional(Schema.Boolean),
      headSha: Schema.optional(TrimmedNonEmptyString),
      headBranch: TrimmedNonEmptyString,
      state: PullRequestState,
    }),
  ),
});
export type PullRequestStack = typeof PullRequestStack.Type;

export const PullRequestDiffStat = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type PullRequestDiffStat = typeof PullRequestDiffStat.Type;

export const PullRequestListStatsInput = Schema.Struct({
  refs: Schema.Array(PullRequestRef).check(Schema.isMaxLength(500)),
});
export type PullRequestListStatsInput = typeof PullRequestListStatsInput.Type;

export const PullRequestListStatsResult = Schema.Struct({
  stats: Schema.Array(PullRequestDiffStat),
});
export type PullRequestListStatsResult = typeof PullRequestListStatsResult.Type;

export const PullRequestFilterOptionKind = Schema.Literals(["labels", "authors"]);
export type PullRequestFilterOptionKind = typeof PullRequestFilterOptionKind.Type;

/** Scoped like `PullRequestListInput`, so the options come from the repositories it lists. */
export const PullRequestFilterOptionsInput = Schema.Struct({
  kind: PullRequestFilterOptionKind,
  projectId: Schema.optional(ProjectId),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  host: Schema.optional(TrimmedNonEmptyString),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
});
export type PullRequestFilterOptionsInput = typeof PullRequestFilterOptionsInput.Type;

export const PullRequestFilterOptions = Schema.Struct({
  labels: Schema.Array(PullRequestLabel),
  authors: Schema.Array(PullRequestActor),
  truncated: Schema.Boolean,
});
export type PullRequestFilterOptions = typeof PullRequestFilterOptions.Type;

/**
 * A separate request rather than a flag on the reads, so an explicit "refresh" one person
 * presses is the only thing that spends host requests — every ordinary read shares.
 */
export const PullRequestInvalidateInput = Schema.Struct({
  reference: Schema.optional(PullRequestRef),
  filesViewedOnly: Schema.optional(Schema.Boolean),
});
export type PullRequestInvalidateInput = typeof PullRequestInvalidateInput.Type;

export const PullRequestReportStateInput = Schema.Struct({
  reference: PullRequestRef,
  state: PullRequestState,
  isDraft: Schema.optional(Schema.Boolean),
});
export type PullRequestReportStateInput = typeof PullRequestReportStateInput.Type;

export const PullRequestDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  capabilities: PullRequestCapabilities,
  viewerPermissions: PullRequestViewerPermissions,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headSha: Schema.optional(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  observedAt: Schema.optional(Schema.Finite),
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  mergeCapabilities: PullRequestMergeCapabilities,
  viewer: Schema.optional(TrimmedNonEmptyString),
  baseComparison: Schema.optional(PullRequestBaseComparison),
  behindBy: Schema.optional(NonNegativeInt),
  /** Absent means the host does not report auto-merge state, not that it is off. */
  autoMergeEnabled: Schema.optional(Schema.Boolean),
  autoMergeMethod: Schema.optional(PullRequestMergeMethod),
  workflowApprovalsRequired: Schema.optional(NonNegativeInt),
  maintainerCanModify: Schema.optional(Schema.Boolean),
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestChecks = Schema.Struct({
  observedAt: Schema.optional(Schema.Finite),
  state: PullRequestState,
  checks: Schema.Array(PullRequestCheck),
});
export type PullRequestChecks = typeof PullRequestChecks.Type;

export const PullRequestActivity = Schema.Struct({
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  reviewers: Schema.optional(Schema.Array(PullRequestActor)),
  comments: Schema.Array(PullRequestComment),
  commentCount: NonNegativeInt,
  commentsTruncated: Schema.Boolean,
  reviewThreadsTruncated: Schema.optional(Schema.Boolean),
  reviewThreads: Schema.Array(PullRequestReviewThread),
  commits: Schema.Array(PullRequestCommit),
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
});
export type PullRequestActivity = typeof PullRequestActivity.Type;

export const PullRequestDetailView = Schema.Struct({
  ...PullRequestDetail.fields,
  ...PullRequestActivity.fields,
  author: Schema.NullOr(PullRequestActor),
  reviewers: Schema.Array(PullRequestActor),
});
export type PullRequestDetailView = typeof PullRequestDetailView.Type;

/** GitHub refuses diffs past 300 files, so callers must page large changes. */
export const PullRequestDiffInput = Schema.Struct({
  ...PullRequestRef.fields,
  cursor: Schema.optional(TrimmedNonEmptyString),
  commit: Schema.optional(TrimmedNonEmptyString),
});
export type PullRequestDiffInput = typeof PullRequestDiffInput.Type;

export const PullRequestOmittedFileStat = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type PullRequestOmittedFileStat = typeof PullRequestOmittedFileStat.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  /** Content omitted within this slice; nextCursor separately indicates more slices. */
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  omittedFileStats: Schema.optional(Schema.Array(PullRequestOmittedFileStat)),
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestDiffFileContentsInput = Schema.Struct({
  ...PullRequestRef.fields,
  commit: Schema.optional(TrimmedNonEmptyString),
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type PullRequestDiffFileContentsInput = typeof PullRequestDiffFileContentsInput.Type;

export const PullRequestDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type PullRequestDiffFileContentsResult = typeof PullRequestDiffFileContentsResult.Type;

const MAX_FILE_PATH_LENGTH = 4096;

// Preserve filename whitespace so viewed marks match host paths.
const FilePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_FILE_PATH_LENGTH));

export const PullRequestFileViewedState = Schema.Literals(["unviewed", "viewed", "dismissed"]);
export type PullRequestFileViewedState = typeof PullRequestFileViewedState.Type;

export const PullRequestFileViewed = Schema.Struct({
  path: FilePath,
  state: PullRequestFileViewedState,
});
export type PullRequestFileViewed = typeof PullRequestFileViewed.Type;

export const PullRequestFilesViewedResult = Schema.Struct({
  /** Only the files the host reported a state for. A file missing from this list is unviewed. */
  files: Schema.Array(PullRequestFileViewed),
  truncated: Schema.Boolean,
});
export type PullRequestFilesViewedResult = typeof PullRequestFilesViewedResult.Type;

const PullRequestLineCount = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

/**
 * A change's line counts split by what the changed files are, judged from their paths. Null when
 * the host gives no per-file counts, or has more files than one read covers: a split of part of
 * the change would not add up to the totals shown beside it.
 */
export const PullRequestChangeBreakdown = Schema.NullOr(
  Schema.Struct({
    code: PullRequestLineCount,
    tests: PullRequestLineCount,
    mocks: PullRequestLineCount,
    generated: PullRequestLineCount,
    // Servers from before the docs split send no key; their docs lines sit in `code`.
    docs: PullRequestLineCount.pipe(
      Schema.withDecodingDefault(Effect.succeed({ additions: 0, deletions: 0 })),
    ),
  }),
);
export type PullRequestChangeBreakdown = typeof PullRequestChangeBreakdown.Type;

const MAX_FILES_VIEWED_PRESSES = 500;

export const PullRequestSetFilesViewedInput = Schema.Struct({
  ...PullRequestRef.fields,
  files: Schema.Array(
    Schema.Struct({
      path: FilePath,
      viewed: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(MAX_FILES_VIEWED_PRESSES)),
});
export type PullRequestSetFilesViewedInput = typeof PullRequestSetFilesViewedInput.Type;

export const PullRequestStackHead = Schema.Struct({
  number: PositiveInt,
  headSha: TrimmedNonEmptyString,
});
export type PullRequestStackHead = typeof PullRequestStackHead.Type;

export const PullRequestActionInput = Schema.Struct({
  /** Native stack scope; only send to environments advertising pullRequestStackActions. */
  stackNumber: Schema.optional(PositiveInt),
  expectedStackHeads: Schema.optional(Schema.Array(PullRequestStackHead)),
  ...PullRequestRef.fields,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  updateMethod: Schema.optional(PullRequestUpdateMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

// Preserve whitespace because it affects Markdown formatting.
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: CommentBody,
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

export const PullRequestUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
  maintainerCanModify: Schema.optional(Schema.Boolean),
});
export type PullRequestUpdateInput = typeof PullRequestUpdateInput.Type;

/** Comment kind selects the endpoint; GitHub uses separate mutations for conversation and line comments. */
export const PullRequestCommentUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  commentId: TrimmedNonEmptyString,
  kind: Schema.Literals(["issue-comment", "review-comment"]),
  body: CommentBody,
});
export type PullRequestCommentUpdateInput = typeof PullRequestCommentUpdateInput.Type;

export const PullRequestReviewPosition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("added"),
    newLine: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("deleted"),
    oldLine: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("context"),
    oldLine: PositiveInt,
    newLine: PositiveInt,
    side: PullRequestDiffSide,
  }),
]);
export type PullRequestReviewPosition = typeof PullRequestReviewPosition.Type;

export const PullRequestReviewCommentDraft = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** GitLab needs both names for renamed-file comments; hosts using one path ignore this. */
  oldPath: Schema.optional(TrimmedNonEmptyString),
  position: PullRequestReviewPosition,
  /**
   * The first line of a comment on a range, which ends at `position`. Sent only to a host whose
   * capabilities include `review.rangeComment`.
   */
  startPosition: Schema.optional(PullRequestReviewPosition),
  body: CommentBody,
});
export type PullRequestReviewCommentDraft = typeof PullRequestReviewCommentDraft.Type;

export const PullRequestSubmitReviewInput = Schema.Struct({
  ...PullRequestRef.fields,
  verdict: PullRequestReviewVerdict,
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comments: Schema.Array(PullRequestReviewCommentDraft),
});
export type PullRequestSubmitReviewInput = typeof PullRequestSubmitReviewInput.Type;

export const PullRequestThreadCommentsInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  cursor: TrimmedNonEmptyString,
});
export type PullRequestThreadCommentsInput = typeof PullRequestThreadCommentsInput.Type;

export const PullRequestThreadCommentsResult = Schema.Struct({
  comments: Schema.Array(PullRequestThreadComment),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestThreadCommentsResult = typeof PullRequestThreadCommentsResult.Type;

export const PullRequestThreadReplyInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  body: CommentBody,
});
export type PullRequestThreadReplyInput = typeof PullRequestThreadReplyInput.Type;

export const PullRequestThreadResolutionInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  resolved: Schema.Boolean,
});
export type PullRequestThreadResolutionInput = typeof PullRequestThreadResolutionInput.Type;

export const PullRequestReactionInput = Schema.Struct({
  ...PullRequestRef.fields,
  subjectId: Schema.optional(TrimmedNonEmptyString),
  content: PullRequestReactionContent,
  reacted: Schema.Boolean,
});
export type PullRequestReactionInput = typeof PullRequestReactionInput.Type;

export const PullRequestReviewerRequestInput = Schema.Struct({
  ...PullRequestRef.fields,
  reviewers: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, kind: PullRequestReviewerKind }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  requested: Schema.Boolean,
});
export type PullRequestReviewerRequestInput = typeof PullRequestReviewerRequestInput.Type;

export const PullRequestLabelChangeInput = Schema.Struct({
  ...PullRequestRef.fields,
  labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  applied: Schema.Boolean,
});
export type PullRequestLabelChangeInput = typeof PullRequestLabelChangeInput.Type;

/**
 * The names keep their `cli-` prefix for wire compatibility; for a host read with a credential
 * rather than a tool they mean "no credential" and "a refused credential".
 */
const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

/**
 * `author:me` names whoever is signed in to the host being read, GitHub's `@me` spelled either
 * way. A host's own search would answer it, but the page and the server both re-check an author
 * against the row's login, so the name is resolved before either comparison rather than being
 * matched as the literal login "me".
 */
export function resolvePullRequestAuthorFilter(
  author: string,
  viewer: string | null | undefined,
): string {
  const trimmed = author.trim();
  if (!/^@?me$/i.test(trimmed)) return trimmed;
  return viewer === null || viewer === undefined || viewer.trim().length === 0 ? trimmed : viewer;
}

export class PullRequestUnavailableError extends Schema.TaggedError<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    /**
     * What the host needs on the server, in its own words. Absent from older servers, which
     * shipped no such field, and for a host that names nothing.
     */
    requirement: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "cli-missing":
        return this.requirement ?? "The tool this host is read through is not installed or set up.";
      case "cli-unauthenticated":
        return this.requirement ?? "This host has no working credentials.";
      case "provider-unsupported":
        return "Change requests cannot be browsed for this project's host yet.";
    }
  }
}

export class PullRequestOperationError extends Schema.TaggedError<PullRequestOperationError>()(
  "PullRequestOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.Literal("not-found")),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Pull request operation ${this.operation} failed: ${this.detail}`;
  }
}

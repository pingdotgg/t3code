import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

const PullRequestQualifierValue = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const PullRequestQualifierValues = Schema.Array(PullRequestQualifierValue).check(
  Schema.isMaxLength(10),
);

export const PullRequestListFilters = Schema.Struct({
  draft: Schema.optional(Schema.Literals(["only", "hide"])),
  review: Schema.optional(
    Schema.Literals(["approved", "changes-requested", "review-required", "none"]),
  ),
  checks: Schema.optional(Schema.Literals(["passing", "failing"])),
  /** GitHub label qualifiers: every group must match; any name within a group suffices. */
  labels: Schema.optional(Schema.Array(PullRequestQualifierValues).check(Schema.isMaxLength(10))),
  excludedLabels: Schema.optional(PullRequestQualifierValues),
  author: Schema.optional(PullRequestQualifierValue),
});
export type PullRequestListFilters = typeof PullRequestListFilters.Type;

export const PullRequestChecksState = Schema.Literals(["passing", "failing", "pending"]);
export type PullRequestChecksState = typeof PullRequestChecksState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals([
  "merge",
  "ready",
  "draft",
  "close",
  "reopen",
  "delete-branch",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
  "revert",
  "approve-workflows",
]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestUpdateMethod = Schema.Literals(["merge", "rebase"]);
export type PullRequestUpdateMethod = typeof PullRequestUpdateMethod.Type;

export const PullRequestBaseComparison = Schema.Literals(["up-to-date", "behind", "unknown"]);
export type PullRequestBaseComparison = typeof PullRequestBaseComparison.Type;

export const PullRequestActor = Schema.Struct({
  isBot: Schema.optional(Schema.Boolean),
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

export const PullRequestCheckStatus = Schema.Literals([
  "pending",
  "action-required",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

export const PullRequestReactionContent = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type PullRequestReactionContent = typeof PullRequestReactionContent.Type;

export const PullRequestReaction = Schema.Struct({
  content: PullRequestReactionContent,
  count: PositiveInt,
  /** Excludes the viewer's login when viewerHasReacted; count still includes them. */
  actors: Schema.Array(TrimmedNonEmptyString),
  viewerHasReacted: Schema.Boolean,
});
export type PullRequestReaction = typeof PullRequestReaction.Type;

export const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
  canEdit: Schema.optional(Schema.Boolean),
});
export type PullRequestComment = typeof PullRequestComment.Type;

export const PullRequestDiffSide = Schema.Literals(["left", "right"]);
export type PullRequestDiffSide = typeof PullRequestDiffSide.Type;

export const PullRequestReviewVerdict = Schema.Literals(["comment", "approve", "request-changes"]);
export type PullRequestReviewVerdict = typeof PullRequestReviewVerdict.Type;

export const PullRequestThreadComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  url: Schema.NullOr(Schema.String),
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
  canEdit: Schema.optional(Schema.Boolean),
});
export type PullRequestThreadComment = typeof PullRequestThreadComment.Type;

export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  side: PullRequestDiffSide,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  comments: Schema.Array(PullRequestThreadComment),
  commentCount: Schema.optional(NonNegativeInt),
  nextCommentsCursor: Schema.optional(TrimmedNonEmptyString),
  /** Can only narrow repository-wide resolve permission. Absent when unreported. */
  canResolve: Schema.optional(Schema.Boolean),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

export const PullRequestReviewerKind = Schema.Literals(["user", "team"]);
export type PullRequestReviewerKind = typeof PullRequestReviewerKind.Type;

export const PullRequestReviewerCandidate = Schema.Struct({
  ...PullRequestActor.fields,
  id: TrimmedNonEmptyString,
  kind: PullRequestReviewerKind,
  isRequested: Schema.Boolean,
});
export type PullRequestReviewerCandidate = typeof PullRequestReviewerCandidate.Type;

export const PullRequestReviewerCandidateList = Schema.Struct({
  candidates: Schema.Array(PullRequestReviewerCandidate),
  truncated: Schema.Boolean,
});
export type PullRequestReviewerCandidateList = typeof PullRequestReviewerCandidateList.Type;

export const PullRequestLabelCandidate = Schema.Struct({
  ...PullRequestLabel.fields,
  description: Schema.NullOr(Schema.String),
  isApplied: Schema.Boolean,
});
export type PullRequestLabelCandidate = typeof PullRequestLabelCandidate.Type;

export const PullRequestLabelCandidateList = Schema.Struct({
  candidates: Schema.Array(PullRequestLabelCandidate),
  truncated: Schema.Boolean,
});
export type PullRequestLabelCandidateList = typeof PullRequestLabelCandidateList.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  authors: Schema.optional(Schema.Array(PullRequestActor)),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

export const PullRequestReviewCapabilities = Schema.Struct({
  inlineComment: Schema.Boolean,
  reply: Schema.Boolean,
  resolve: Schema.Boolean,
  verdicts: ForwardCompatibleArray(PullRequestReviewVerdict),
});
export type PullRequestReviewCapabilities = typeof PullRequestReviewCapabilities.Type;

export const PullRequestEditCapabilities = Schema.Struct({
  changeRequest: Schema.Boolean,
  comment: Schema.Boolean,
});
export type PullRequestEditCapabilities = typeof PullRequestEditCapabilities.Type;

export const PullRequestReviewerCapabilities = Schema.Struct({
  request: Schema.Boolean,
  listCandidates: Schema.Boolean,
});
export type PullRequestReviewerCapabilities = typeof PullRequestReviewerCapabilities.Type;

export const PullRequestViewedFilesStore = Schema.Literals(["host", "environment"]);
export type PullRequestViewedFilesStore = typeof PullRequestViewedFilesStore.Type;

export const PullRequestCapabilities = Schema.Struct({
  diff: Schema.Boolean,
  comment: Schema.Boolean,
  actions: ForwardCompatibleArray(PullRequestAction),
  mergeMethods: ForwardCompatibleArray(PullRequestMergeMethod),
  deleteBranch: Schema.optional(Schema.Boolean),
  /**
   * Absent where it cannot at all, which is every host that has not said otherwise — so a
   * provider that says nothing offers nothing.
   */
  updateMethods: Schema.optional(ForwardCompatibleArray(PullRequestUpdateMethod)),
  search: Schema.Boolean,
  reactions: Schema.optional(Schema.Boolean),
  viewedFiles: Schema.optional(PullRequestViewedFilesStore),
  review: PullRequestReviewCapabilities,
  reviewers: PullRequestReviewerCapabilities,
  edit: Schema.optional(PullRequestEditCapabilities),
  stacks: Schema.optional(Schema.Boolean),
  stackActions: Schema.optional(Schema.Boolean),
  labels: Schema.optional(Schema.Boolean),
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

/** Unreported host permissions are granted. */
export const PullRequestViewerPermissions = Schema.Struct({
  stackRebase: Schema.optional(Schema.Boolean),
  actions: ForwardCompatibleArray(PullRequestAction),
  comment: Schema.Boolean,
  resolve: Schema.Boolean,
  verdicts: ForwardCompatibleArray(PullRequestReviewVerdict),
  requestReviewers: Schema.Boolean,
  updateMethods: Schema.optional(ForwardCompatibleArray(PullRequestUpdateMethod)),
  labels: Schema.optional(Schema.Boolean),
  editChangeRequest: Schema.optional(Schema.Boolean),
});
export type PullRequestViewerPermissions = typeof PullRequestViewerPermissions.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestStackMembership = Schema.Struct({
  number: PositiveInt,
  position: PositiveInt,
  size: PositiveInt,
  base: TrimmedNonEmptyString,
});
export type PullRequestStackMembership = typeof PullRequestStackMembership.Type;

export const PullRequestListEntry = Schema.Struct({
  stack: Schema.optional(PullRequestStackMembership),
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  /** Zero until fetched through `PullRequestListStatsInput`; GitHub listings omit counts. */
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  observedAt: Schema.optional(Schema.Finite),
  viewerReviewRequested: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  checksState: Schema.optional(PullRequestChecksState),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestListCursors = Schema.Record(
  TrimmedNonEmptyString,
  TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
);
export type PullRequestListCursors = typeof PullRequestListCursors.Type;

export const PullRequestListInput = Schema.Struct({
  state: PullRequestListState,
  involvement: Schema.optional(PullRequestInvolvement),
  filters: Schema.optional(PullRequestListFilters),
  projectId: Schema.optional(ProjectId),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  host: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  cursors: Schema.optional(PullRequestListCursors),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

export const PullRequestProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  searchesOnHost: Schema.Boolean,
  actions: Schema.optional(ForwardCompatibleArray(PullRequestAction)),
  projectCount: PositiveInt,
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestProviderSummary = typeof PullRequestProviderSummary.Type;

export const PullRequestListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type PullRequestListProjectError = typeof PullRequestListProjectError.Type;

export const PullRequestListResult = Schema.Struct({
  /** Unreadable hosts are absent; JSON codecs reject optional record values. */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(PullRequestProviderSummary),
  /** Re-sort after appending: one repository's older slice may outrank another's existing rows. */
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestListProjectError),
  truncated: Schema.Boolean,
  nextCursors: PullRequestListCursors,
});
export type PullRequestListResult = typeof PullRequestListResult.Type;

export const PullRequestRef = Schema.Struct({
  projectId: ProjectId,
  host: Schema.optional(TrimmedNonEmptyString),
  expectedAccountId: Schema.optional(TrimmedNonEmptyString),
  allowStale: Schema.optional(Schema.Boolean),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestRef = typeof PullRequestRef.Type;

export const PullRequestRoutingIdentityInput = Schema.Struct({
  host: TrimmedNonEmptyString,
});
export type PullRequestRoutingIdentityInput = typeof PullRequestRoutingIdentityInput.Type;

export const PullRequestRoutingIdentityResult = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  provider: Schema.Literal("github"),
  viewer: TrimmedNonEmptyString,
});
export type PullRequestRoutingIdentityResult = typeof PullRequestRoutingIdentityResult.Type;

export const PullRequestRoutingResult = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  viewer: TrimmedNonEmptyString,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type PullRequestRoutingResult = typeof PullRequestRoutingResult.Type;

export const PullRequestLinkedThreadsResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
      archivedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
});
export type PullRequestLinkedThreadsResult = typeof PullRequestLinkedThreadsResult.Type;

export const PullRequestPreview = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type PullRequestPreview = typeof PullRequestPreview.Type;

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

/** Only explicit refresh bypasses shared host reads. */
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
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestChecks = Schema.Struct({
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

export const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

// cli- prefixes stay for wire compatibility; GitHub/Bitbucket use them for missing or refused credentials.
const PROVIDER_REQUIREMENT = new Map<
  string,
  { readonly missing: string; readonly unauthenticated: string }
>([
  [
    "github",
    {
      missing:
        "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI (https://cli.github.com/) and run `gh auth login`.",
      unauthenticated:
        "GitHub has no working credential for this host. Run `gh auth login`, or check the account and hosts in Settings → Source Control.",
    },
  ],
  [
    "forgejo",
    {
      missing:
        "Install Forgejo CLI (`fj` 0.6 or later) from https://codeberg.org/forgejo-contrib/forgejo-cli or Gitea CLI (`tea` 0.16 or later) from https://gitea.com/gitea/tea to browse Forgejo pull requests.",
      unauthenticated:
        "Authenticate your Forgejo or Gitea server with `fj --host <server-url> auth add-token` on the T3 Code server. If fj is missing or unconfigured for that server, use `tea login add`. A configured fj account must be repaired with fj.",
    },
  ],
  [
    "gitlab",
    {
      missing:
        "GitLab CLI (`glab`) is required to browse change requests on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
      unauthenticated: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
    },
  ],
  [
    "azure-devops",
    {
      missing:
        "Azure CLI (`az`) with the Azure DevOps extension is required. Install `az`, then run `az extension add --name azure-devops`.",
      unauthenticated: "Azure CLI is not signed in. Run `az login` and retry.",
    },
  ],
  [
    "bitbucket",
    {
      missing:
        "Bitbucket needs API credentials on the server. Add them in Settings → Source Control.",
      unauthenticated:
        "Bitbucket rejected the configured credentials. Check them in Settings → Source Control.",
    },
  ],
]);

export function pullRequestHostOf(
  identity:
    | {
        readonly canonicalKey?: string | undefined;
        readonly locator?: { readonly remoteUrl: string } | undefined;
      }
    | null
    | undefined,
  kind: SourceControlProviderKind,
): string {
  if (kind === "forgejo") {
    try {
      const remote = new URL(identity?.locator?.remoteUrl ?? "");
      if (remote.protocol === "http:" || remote.protocol === "https:")
        return remote.host.toLowerCase();
    } catch {}
  }
  const host = identity?.canonicalKey?.split("/")[0]?.trim();
  return host === undefined || host.length === 0 ? kind : host.toLowerCase();
}

/** Resolve me/@me to the host's signed-in login before client or server comparisons. */
export function resolvePullRequestAuthorFilter(
  author: string,
  viewer: string | null | undefined,
): string {
  const trimmed = author.trim();
  if (!/^@?me$/i.test(trimmed)) return trimmed;
  return viewer === null || viewer === undefined || viewer.trim().length === 0 ? trimmed : viewer;
}

export function pullRequestProviderRequirement(
  provider: SourceControlProviderKind,
  reason: PullRequestUnavailableReason,
): string | null {
  const requirement = PROVIDER_REQUIREMENT.get(provider);
  if (requirement === undefined) return null;
  switch (reason) {
    case "cli-missing":
      return requirement.missing;
    case "cli-unauthenticated":
      return requirement.unauthenticated;
    case "provider-unsupported":
      return null;
  }
}

export class PullRequestUnavailableError extends Schema.TaggedError<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    const requirement =
      this.provider === undefined ? undefined : PROVIDER_REQUIREMENT.get(this.provider);
    switch (this.reason) {
      case "cli-missing":
        return (
          requirement?.missing ?? "The tool this host is read through is not installed or set up."
        );
      case "cli-unauthenticated":
        return requirement?.unauthenticated ?? "This host has no working credentials.";
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

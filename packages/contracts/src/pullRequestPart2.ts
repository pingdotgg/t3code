import * as Schema from "effect/Schema";
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
import { PullRequestListStatsInput } from "./pullRequest.ts";

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

const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

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
  /**
   * An inline comment can cover a range of lines rather than its last one. Absent, as from a
   * server that predates it, means one line.
   */
  rangeComment: Schema.optional(Schema.Boolean),
  reply: Schema.Boolean,
  resolve: Schema.Boolean,
  verdicts: ForwardCompatibleArray(PullRequestReviewVerdict),
});
export type PullRequestReviewCapabilities = typeof PullRequestReviewCapabilities.Type;

const PullRequestEditCapabilities = Schema.Struct({
  changeRequest: Schema.Boolean,
  comment: Schema.Boolean,
  maintainerEdits: Schema.optional(Schema.Boolean),
});
type PullRequestEditCapabilities = typeof PullRequestEditCapabilities.Type;

export const PullRequestReviewerCapabilities = Schema.Struct({
  request: Schema.Boolean,
  listCandidates: Schema.Boolean,
});
export type PullRequestReviewerCapabilities = typeof PullRequestReviewerCapabilities.Type;

const PullRequestViewedFilesStore = Schema.Literals(["host", "environment"]);
type PullRequestViewedFilesStore = typeof PullRequestViewedFilesStore.Type;

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
  /**
   * Every head gets at least one check, so a head that has gone a while without any means none
   * reported rather than that the repository runs none. Absent means an empty list says nothing.
   */
  checksAlwaysReport: Schema.optional(Schema.Boolean),
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
  maintainerEdits: Schema.optional(Schema.Boolean),
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
  provider: SourceControlProviderKind,
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

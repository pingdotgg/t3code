import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Pull requests in this surface are provided exclusively through GitHub. */
export const PullRequestProviderKind = Schema.Literal("github");
export type PullRequestProviderKind = typeof PullRequestProviderKind.Type;

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

/**
 * What a listing asks for, which is the three states a change request can be in plus the option
 * to span them. Separate from `PullRequestState` because a change request is never "all" — only
 * a request for one can be.
 */
export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals(["merge", "ready", "draft", "close", "reopen"]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  /** Null where a host does not report one, which is what the initials fall back to. */
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
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

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
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
});
export type PullRequestComment = typeof PullRequestComment.Type;

/**
 * Which file a diff line belongs to: `left` is the version before the change, `right` the
 * version after. A comment has to name one, because a unified diff shows both at once and the
 * same line number means two different lines.
 */
export const PullRequestDiffSide = Schema.Literals(["left", "right"]);
export type PullRequestDiffSide = typeof PullRequestDiffSide.Type;

/** What submitting a review says about the change, beyond the words in it. */
export const PullRequestReviewVerdict = Schema.Literals(["comment", "approve", "request-changes"]);
export type PullRequestReviewVerdict = typeof PullRequestReviewVerdict.Type;

export const PullRequestThreadComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
});
export type PullRequestThreadComment = typeof PullRequestThreadComment.Type;

/**
 * A conversation anchored to a line of the diff. The detail carries these alongside `comments`
 * rather than instead of them: the timeline wants one flat, chronological list, and the diff
 * wants whole threads pinned to their line — the same remarks, read two different ways.
 */
export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  /** Null when the host anchors the thread to a file rather than to a line. */
  line: Schema.NullOr(PositiveInt),
  side: PullRequestDiffSide,
  isResolved: Schema.Boolean,
  /**
   * The line the thread was written against is no longer in the diff, so it cannot be shown
   * against the code. Such a thread is listed separately rather than pinned to the wrong line.
   */
  isOutdated: Schema.Boolean,
  comments: Schema.Array(PullRequestThreadComment),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

/**
 * Whether a reviewer is a person or a group of them the host addresses as one. GitHub is the only
 * host here that takes a review request for a team; the others name individuals only, so nothing
 * they report is ever anything but a user.
 */
export const PullRequestReviewerKind = Schema.Literals(["user", "team"]);
export type PullRequestReviewerKind = typeof PullRequestReviewerKind.Type;

/**
 * Somebody a review may be asked of. Carries the actor fields so the menu shows the same face and
 * handle the rest of the page does, and a team wears them too — its slug stands in for a login.
 */
export const PullRequestReviewerCandidate = Schema.Struct({
  ...PullRequestActor.fields,
  /**
   * How GitHub addresses this reviewer when a review is requested. A user has a login and a team
   * has a slug. The page returns this opaque identifier unchanged.
   */
  id: TrimmedNonEmptyString,
  kind: PullRequestReviewerKind,
  /** A review has already been asked of them, so pressing them takes the request back. */
  isRequested: Schema.Boolean,
});
export type PullRequestReviewerCandidate = typeof PullRequestReviewerCandidate.Type;

export const PullRequestReviewerCandidateList = Schema.Struct({
  /** Never includes the author: nobody is asked to review their own change request. */
  candidates: Schema.Array(PullRequestReviewerCandidate),
  /**
   * The host has more people with access than the read asked for, so somebody missing from the
   * menu may still be somebody this change request can be sent to. Nothing is wrong with the
   * list; it is simply not all of it.
   */
  truncated: Schema.Boolean,
});
export type PullRequestReviewerCandidateList = typeof PullRequestReviewerCandidateList.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
  /** Per-commit line counts where the host can return them without a request per commit. */
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  /**
   * Everyone the host attributes the commit to. Optional because older servers and hosts that
   * do not expose commit authors still produce a useful timeline entry.
   */
  authors: Schema.optional(Schema.Array(PullRequestActor)),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

/**
 * What GitHub can do with a review.
 */
export const PullRequestReviewCapabilities = Schema.Struct({
  /** A new comment can be anchored to a line of the diff. */
  inlineComment: Schema.Boolean,
  /** An existing thread can be replied to. */
  reply: Schema.Boolean,
  /** A thread can be marked resolved, and unresolved again. */
  resolve: Schema.Boolean,
  /** The verdicts a submitted review can carry. Empty means reviews cannot be submitted. */
  verdicts: Schema.Array(PullRequestReviewVerdict),
});
export type PullRequestReviewCapabilities = typeof PullRequestReviewCapabilities.Type;

/**
 * What GitHub can do about who reviews.
 */
export const PullRequestReviewerCapabilities = Schema.Struct({
  /** A review can be asked of somebody, and the request taken back. */
  request: Schema.Boolean,
  /**
   * The people who may be asked can be listed. False where the host has no such list to give,
   * which leaves the page to take a name rather than offer a menu — a guessed list would be worse,
   * because a name missing from it reads as a name that cannot be asked.
   */
  listCandidates: Schema.Boolean,
});
export type PullRequestReviewerCapabilities = typeof PullRequestReviewerCapabilities.Type;

/**
 * What GitHub can actually do, so the surface hides controls that would fail.
 */
export const PullRequestCapabilities = Schema.Struct({
  /** A unified patch can be fetched for the change request. */
  diff: Schema.Boolean,
  /** A comment can be posted, and the conversation read back. */
  comment: Schema.Boolean,
  /** The actions this host can carry out; anything absent is never offered. */
  actions: Schema.Array(PullRequestAction),
  /** Merge strategies the provider itself offers, before repository settings narrow them. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
  /**
   * The host can narrow a listing by free text. False means it answers unnarrowed and whoever
   * asked has to do the narrowing — which is a different promise, so the page is told rather
   * than left to show every change request on that host as a search result.
   */
  search: Schema.Boolean,
  review: PullRequestReviewCapabilities,
  reviewers: PullRequestReviewerCapabilities,
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

/**
 * What the signed-in account may do with this change request, which is a different question from
 * `capabilities`: that says what the host is able to do at all, and this says whether this viewer
 * is allowed to ask for it. A host that merges pull requests still will not let a stranger merge
 * one, so a control belongs on the page only where the two agree.
 *
 * A permission the host reports nothing about is granted rather than withheld. Hiding a control
 * from someone who may in fact use it leaves them no way through and no reason given, while
 * offering one they may not use ends in the host's own refusal — which at least says why.
 */
export const PullRequestViewerPermissions = Schema.Struct({
  /** Which of the actions this viewer may take; anything absent is theirs to look at only. */
  actions: Schema.Array(PullRequestAction),
  /** This viewer may write a remark: a comment, a reply, or a note against a line. */
  comment: Schema.Boolean,
  /** This viewer may mark a review conversation resolved, and unresolved again. */
  resolve: Schema.Boolean,
  /** The verdicts this viewer may submit a review with. Empty means they may not review. */
  verdicts: Schema.Array(PullRequestReviewVerdict),
  /** This viewer may ask somebody for a review, and take the request back again. */
  requestReviewers: Schema.Boolean,
});
export type PullRequestViewerPermissions = typeof PullRequestViewerPermissions.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestListEntry = Schema.Struct({
  provider: PullRequestProviderKind,
  /**
   * The host below which `repository` is addressed, so the same provider kind can serve more
   * than one account — github.com and a GitHub Enterprise install are different identities.
   */
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
  /**
   * Zero where the host has not been asked for the counts yet, which on GitHub is every row a
   * listing hands over: they are read afterwards, through `PullRequestListStatsInput`. Zero is
   * what a host that reports no counts at all has always sent, and what the page already draws
   * as no stat rather than as an empty change.
   */
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  viewerReviewRequested: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

/**
 * Where each repository a listing already reached carries on from, keyed `"<host> <repository>"`
 * — which is how a listing tells two repositories apart, since the same `owner/repo` exists on
 * github.com and on an Enterprise install at once.
 *
 * Each value is opaque: only the provider that issued one knows what it means, and the page hands
 * back exactly what it was given rather than composing one.
 */
export const PullRequestListCursors = Schema.Record(
  TrimmedNonEmptyString,
  // Bounded because it arrives from the page and is unfolded into a host's own filter.
  TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
);
export type PullRequestListCursors = typeof PullRequestListCursors.Type;

export const PullRequestListInput = Schema.Struct({
  state: PullRequestListState,
  involvement: Schema.optional(PullRequestInvolvement),
  projectId: Schema.optional(ProjectId),
  /**
   * Narrows the listing to one host, named as the host itself rather than as its provider kind:
   * github.com and a GitHub Enterprise install are two accounts, and a kind cannot tell them
   * apart. Absent means every host the workspace has.
   */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows to return per repository, which with a continuation is rows per slice. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /**
   * Carry on from an answer already on the page rather than read the listing again. Only the
   * repositories named here are read, one slice each — which is what makes a further page cost
   * one slice rather than every repository over again at a larger size. A repository the page has
   * enough of is simply left out.
   *
   * Absent asks for the listing from the top, which is what raising `limit` alone has always
   * done and still does.
   */
  cursors: Schema.optional(PullRequestListCursors),
  /**
   * Free text GitHub is asked to match, rather than a filter over the rows that
   * have already arrived: a listing only ever holds a page per repository, so a search that
   * never leaves the client can only find what happened to be loaded. What a match means is the
   * host's own business — GitHub reads the title and body.
   *
   * Bounded because it travels into a CLI argument and a query string, and no host makes
   * anything of a search term this long.
   */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

/**
 * A host the workspace has projects on, and whether it can be read right now. Drives the host
 * switcher and explains projects the list leaves out.
 *
 * One per host rather than per provider kind, because signing in is a question about the host:
 * a workspace can hold repositories on github.com and on a GitHub Enterprise install at once,
 * and the two are separate accounts that succeed and fail independently.
 */
export const PullRequestProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: PullRequestProviderKind,
  /** False where a search has to be applied to the rows after they arrive. */
  searchesOnHost: Schema.Boolean,
  projectCount: PositiveInt,
  /** False when the provider's CLI or credentials are missing, with `detail` saying which. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestProviderSummary = typeof PullRequestProviderSummary.Type;

/** One project whose repository could not be read; healthy projects still return entries. */
export const PullRequestListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type PullRequestListProjectError = typeof PullRequestListProjectError.Type;

export const PullRequestListResult = Schema.Struct({
  /**
   * The signed-in account per host, which is what involvement filtering compares. Keyed by
   * host rather than by provider kind: two GitHub hosts are two accounts. A host that could
   * not be read is absent rather than present-and-undefined, because an open-keyed record
   * cannot carry an optional value through the JSON codec.
   */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(PullRequestProviderSummary),
  /**
   * By update, newest first, across every repository this answer covers. A page that appends a
   * continuation sorts what it then holds the same way: a repository's next slice is older than
   * that repository's last row, but can still be newer than another repository's.
   */
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestListProjectError),
  /** At least one repository hit the per-repository listing cap. */
  truncated: Schema.Boolean,
  /**
   * Where each repository carries on, to be sent straight back as `cursors`. A repository is
   * absent from this once it has nothing more to give, and also where its host could not be asked
   * in an order a continuation means anything in — so an empty record beside `truncated` means
   * more rows are only reachable by raising `limit`, the way they always were.
   */
  nextCursors: PullRequestListCursors,
});
export type PullRequestListResult = typeof PullRequestListResult.Type;

export const PullRequestRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestRef = typeof PullRequestRef.Type;

/**
 * One row's line counts, read after the listing rather than inside it. On GitHub the pair is
 * 40-60% of the wall clock of the search that answers the whole page — measured over twelve
 * repositories, 7.1s with it and 4.0s without — for two small numbers at the end of a row.
 *
 * So the listing answers without them and the page asks for them next, which is what puts the
 * rows on screen at the speed of everything else on them.
 */
export const PullRequestDiffStat = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type PullRequestDiffStat = typeof PullRequestDiffStat.Type;

/**
 * The rows whose line counts are wanted, which is the rows the page is showing.
 *
 * Bounded at the largest listing a page can hold, since each ref becomes a lookup of its own on
 * the host.
 */
export const PullRequestListStatsInput = Schema.Struct({
  refs: Schema.Array(PullRequestRef).check(Schema.isMaxLength(500)),
});
export type PullRequestListStatsInput = typeof PullRequestListStatsInput.Type;

/**
 * Only the rows that could be answered for. A host with no batched stat read of its own — every
 * one but GitHub, which all report the counts in the listing itself — is simply absent here, and
 * the numbers its listing already carried stand.
 */
export const PullRequestListStatsResult = Schema.Struct({
  stats: Schema.Array(PullRequestDiffStat),
});
export type PullRequestListStatsResult = typeof PullRequestListStatsResult.Type;

/**
 * Forget what the server has cached, so the next read asks the host. With a reference it
 * forgets that one change request's detail and diff; without one it forgets the listings.
 * A separate request rather than a flag on the reads, so an explicit "refresh" one person
 * presses is the only thing that spends host requests — every ordinary read shares.
 */
export const PullRequestInvalidateInput = Schema.Struct({
  reference: Schema.optional(PullRequestRef),
});
export type PullRequestInvalidateInput = typeof PullRequestInvalidateInput.Type;

export const PullRequestDetail = Schema.Struct({
  provider: PullRequestProviderKind,
  capabilities: PullRequestCapabilities,
  /** What this viewer may do, which `capabilities` says nothing about. Both narrow the page. */
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
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  mergeCapabilities: PullRequestMergeCapabilities,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

/**
 * The slower, conversation-shaped half of a change request. It is read independently from the
 * core detail so a host with a deeply paginated review history cannot hold the title, body,
 * checks, and actions off screen. `author` and `reviewers` are optional enrichments: GitHub's
 * conversation query carries avatars and completed reviewers that its basic detail does not.
 */
export const PullRequestActivity = Schema.Struct({
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  reviewers: Schema.optional(Schema.Array(PullRequestActor)),
  comments: Schema.Array(PullRequestComment),
  /**
   * The host's conversation count when it is available. A bounded or failed thread read instead
   * reports a strict lower bound above `comments`, so a surface never presents an incomplete
   * conversation as complete.
   */
  commentCount: NonNegativeInt,
  /**
   * The read stopped at a bound of its own before the host ran out, so `comments` holds less
   * than `commentCount` counts. Nothing else: a conversation read whole is never truncated,
   * however long it is.
   */
  commentsTruncated: Schema.Boolean,
  reviewThreads: Schema.Array(PullRequestReviewThread),
  commits: Schema.Array(PullRequestCommit),
});
export type PullRequestActivity = typeof PullRequestActivity.Type;

/**
 * A diff arrives a slice at a time, because a large change is more than any host will hand over
 * at once — GitHub refuses outright past 300 files — and more than a viewer can lay out in one
 * go. A slice is a whole number of files, never a file cut in half, so each one parses on its
 * own and the reader can start on the first while the rest is still coming.
 */
export const PullRequestDiffInput = Schema.Struct({
  ...PullRequestRef.fields,
  /**
   * Where to carry on from. Absent asks for the first slice. Opaque to the reader: each host
   * counts its files its own way, and only the provider that issued one knows what it means.
   */
  cursor: Schema.optional(TrimmedNonEmptyString),
  /**
   * One commit of the change rather than the whole of it. A large pull request is easier to
   * read a commit at a time, and the author's own commits are the boundaries they chose.
   */
  commit: Schema.optional(TrimmedNonEmptyString),
});
export type PullRequestDiffInput = typeof PullRequestDiffInput.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  /**
   * Something inside this slice could not be shown — a binary file, or a hunk the host declined
   * to inline. Not the same as there being more slices, which `nextCursor` answers.
   */
  truncated: Schema.Boolean,
  /** Where the next slice starts, or null once the diff is whole. */
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestActionInput = Schema.Struct({
  ...PullRequestRef.fields,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

// Not trimmed: the body is markdown, where leading spaces open a code block and two trailing
// spaces are a line break. GitHub rejects bodies past 65536 characters, so that bound is
// enforced here to keep oversized payloads off the wire and out of subprocess plumbing; the
// service rejects a body that is only whitespace.
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));
// Ten maximum-sized remarks plus the review body and bounded paths leave headroom under 1 MiB.
export const MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS = 10;

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: CommentBody,
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

// GitHub paths fit below POSIX's PATH_MAX. Bounding them, together with ten 64 KiB bodies, keeps
// the review body and inline drafts below one MiB before JSON framing.
const PullRequestFilePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

/** One remark in a review that has not been sent yet, anchored to a line of the diff. */
export const PullRequestReviewCommentDraft = Schema.Struct({
  path: PullRequestFilePath,
  /**
   * What the file was called before the change, sent only when it differs.
   */
  oldPath: Schema.optional(PullRequestFilePath),
  line: PositiveInt,
  side: PullRequestDiffSide,
  body: CommentBody,
});
export type PullRequestReviewCommentDraft = typeof PullRequestReviewCommentDraft.Type;

/**
 * A whole review, sent in one go. The line comments travel with the verdict rather than being
 * posted as they are written, so a half-finished review is never visible to anyone else — and
 * so hosts with no notion of a pending review behave the same as the ones that have it.
 */
export const PullRequestSubmitReviewInput = Schema.Struct({
  ...PullRequestRef.fields,
  verdict: PullRequestReviewVerdict,
  /** The review's own words. May be empty, which is how an approval with no remarks is sent. */
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comments: Schema.Array(PullRequestReviewCommentDraft).check(
    Schema.isMaxLength(MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS),
  ),
});
export type PullRequestSubmitReviewInput = typeof PullRequestSubmitReviewInput.Type;

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

/**
 * Asking for a review and taking the request back are one operation with `requested` turned
 * around, and asking again somebody who has already reviewed is what a re-request is — so that is
 * the same operation once more rather than a third one.
 */
export const PullRequestReviewerRequestInput = Schema.Struct({
  ...PullRequestRef.fields,
  /**
   * Who, as the candidate list named them. Bounded because every host bounds it as well — GitHub
   * refuses past fifteen — and because these travel into a request body a page composed.
   */
  reviewers: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, kind: PullRequestReviewerKind }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  requested: Schema.Boolean,
});
export type PullRequestReviewerRequestInput = typeof PullRequestReviewerRequestInput.Type;

export const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

/**
 * What GitHub needs before it can be read, so a failure names the fix rather than the symptom.
 */
const GITHUB_PROVIDER_REQUIREMENT = {
  github: {
    missing:
      "GitHub CLI (`gh`) is required to browse change requests on this host. Install it from https://cli.github.com/ and reload.",
    unauthenticated: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  },
} as const;

/**
 * The feature is switched off entirely. The message is derived from `reason` and the host
 * rather than from whatever the CLI printed, so it stays a stable sentence the UI can show
 * as-is; the underlying failure travels in `cause` (absent for `provider-unsupported`, which
 * has none).
 */
export class PullRequestUnavailableError extends Schema.TaggedErrorClass<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    provider: Schema.optional(PullRequestProviderKind),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    const requirement =
      this.provider === undefined ? undefined : GITHUB_PROVIDER_REQUIREMENT[this.provider];
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

export class PullRequestOperationError extends Schema.TaggedErrorClass<PullRequestOperationError>()(
  "PullRequestOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
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

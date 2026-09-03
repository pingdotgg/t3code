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
import { SourceControlProviderKind } from "./sourceControl.ts";

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

/** Where a review stands overall, as a host that summarises its reviews reports it. */
export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

/** One qualifier's value, bounded because it is written into a host's own search query. */
const PullRequestQualifierValue = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const PullRequestQualifierValues = Schema.Array(PullRequestQualifierValue).check(
  Schema.isMaxLength(10),
);

/**
 * Narrowings beyond state and involvement, each absent by default — an absent field filters
 * nothing, which is what every listing did before there were any. Optional as a whole so a page
 * and a server of different ages still speak to each other.
 *
 * `checks` is host-side only: no row carries its own check state, so a host that cannot match it
 * answers unnarrowed rather than the page pretending to know.
 */
export const PullRequestListFilters = Schema.Struct({
  draft: Schema.optional(Schema.Literals(["only", "hide"])),
  review: Schema.optional(
    Schema.Literals(["approved", "changes-requested", "review-required", "none"]),
  ),
  checks: Schema.optional(Schema.Literals(["passing", "failing"])),
  /**
   * Labels as GitHub's own search reads them: each group is one `label:` qualifier, a row must
   * satisfy every group, and a group holding several names is satisfied by any one of them —
   * `label:size:S,size:XS` finds either size. Typed rather than picked, since a project's labels
   * are its own and no menu can list them. Bounded because each becomes a host search qualifier.
   */
  labels: Schema.optional(Schema.Array(PullRequestQualifierValues).check(Schema.isMaxLength(10))),
  excludedLabels: Schema.optional(PullRequestQualifierValues),
  /** One login, as `author:` names it. */
  author: Schema.optional(PullRequestQualifierValue),
});
export type PullRequestListFilters = typeof PullRequestListFilters.Type;

/** The one-glyph summary of a change request's checks, as its list row wears it. */
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
  /** Bring the base branch's commits into this one, which is what unblocks a stale branch. */
  "update-branch",
  /**
   * Hand the merge to the host: it waits for whatever it requires — a green pipeline, the
   * approvals, an unblocked branch — and merges without anybody coming back. Separate from
   * `merge` because the two answer different questions. `merge` is refused outright by a host
   * that is not ready yet, and this one is for exactly that moment.
   */
  "enable-auto-merge",
  /** Take the standing instruction back, which leaves the change request where it was. */
  "disable-auto-merge",
  /** Open a new change request that reverses a merged one. */
  "revert",
  /** Allow Actions workflows from a fork pull request to begin running. */
  "approve-workflows",
]);
export type PullRequestAction = typeof PullRequestAction.Type;

/**
 * How a stale branch catches up with its base: a merge commit, or a rebase onto it. The two are
 * the host's own choices, not this page's — GitHub offers both and refuses a rebase it cannot
 * replay, so what is offered comes from the host and what is allowed comes from the viewer.
 */
export const PullRequestUpdateMethod = Schema.Literals(["merge", "rebase"]);
export type PullRequestUpdateMethod = typeof PullRequestUpdateMethod.Type;

/**
 * Where the branch stands against the base it would merge into. Separate from `mergeability`,
 * which answers a different question: a branch can be behind and still merge cleanly, and that
 * pairing — out of date, no conflicts — is the one an update button exists for.
 *
 * "unknown" where the host was not asked or could not say, which is every host but GitHub and
 * every pull request whose head repository could not be compared.
 */
export const PullRequestBaseComparison = Schema.Literals(["up-to-date", "behind", "unknown"]);
export type PullRequestBaseComparison = typeof PullRequestBaseComparison.Type;

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
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

/**
 * The reactions a remark can carry. GitHub's eight, which is also what the picker offers: GitLab
 * accepts any emoji as an award, and the ones outside this set are read as nothing rather than
 * shown under a name no other host would recognise.
 */
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

/** One reaction and everyone behind it, which is what the hover on a reaction pill says. */
export const PullRequestReaction = Schema.Struct({
  content: PullRequestReactionContent,
  count: PositiveInt,
  /**
   * Who reacted, as far as the host named them. A host that reports fewer names than it counts
   * leaves the rest out, so this is never longer than `count` and may be shorter. When
   * `viewerHasReacted` is true, the viewer's own login is left out of this list — the page names
   * them "You" instead — but `count` still counts them along with everyone else.
   */
  actors: Schema.Array(TrimmedNonEmptyString),
  /** The signed-in account is one of them, so pressing the pill takes the reaction back. */
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
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
  /** Absent from a host with no reactions at all, which is a different thing from none on this. */
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
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
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
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
  /** Host-reported total, when this thread was read in pages. */
  commentCount: Schema.optional(NonNegativeInt),
  /** Opaque cursor for the next comment page. Absent once this thread is whole. */
  nextCommentsCursor: Schema.optional(TrimmedNonEmptyString),
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
   * How the host addresses this reviewer when a review is requested, which is not always the
   * handle it shows: GitHub takes a login or a team slug, GitLab a numeric user id, Bitbucket an
   * account uuid. Opaque to the page, which sends back whatever the candidate arrived with.
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
 * What a host can do with a review, which is where the four differ most. GitLab has no way to
 * say "changes requested", and Azure DevOps exposes no diff through its CLI, so it has no lines
 * to write against at all.
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
 * What a host lets be rewritten after it has been posted. The two are separate because a host can
 * take one without the other: Azure DevOps takes a new title and description through the same
 * command that closes a pull request, and has no way to post a remark here at all — so nothing it
 * shows in a conversation can be rewritten either.
 */
export const PullRequestEditCapabilities = Schema.Struct({
  /** The change request's own title and description can be rewritten. */
  changeRequest: Schema.Boolean,
  /** A remark can be rewritten by whoever wrote it. */
  comment: Schema.Boolean,
});
export type PullRequestEditCapabilities = typeof PullRequestEditCapabilities.Type;

/**
 * What a host can do about who reviews. The two are independent: a host can take a request without
 * publishing who may receive one, which is Azure DevOps.
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
 * What a provider can actually do, so a surface can hide what is missing rather than offer an
 * action that would fail. Every provider fills this in for itself; nothing is assumed.
 *
 * Hosts differ more than they look: Azure DevOps exposes no patch through its CLI, and
 * Bitbucket has no endpoint that reopens a declined pull request. Both would otherwise be dead
 * buttons.
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
   * How this host can bring a stale branch up to date. Absent where it cannot at all, which is
   * every host that has not said otherwise — so a provider that says nothing offers nothing.
   */
  updateMethods: Schema.optional(Schema.Array(PullRequestUpdateMethod)),
  /**
   * The host can narrow a listing by free text. False means it answers unnarrowed and whoever
   * asked has to do the narrowing — which is a different promise, so the page is told rather
   * than left to show every change request on that host as a search result.
   */
  search: Schema.Boolean,
  /**
   * Reactions can be read from a remark, and added to one or taken back. One flag for both:
   * neither host here reports reactions it will not also take, and a surface that could show a
   * pill it may never press is a surface offering nothing. Optional for the same reason as
   * `updateMethods` and `edit`: a server that says nothing about reactions has none, which is
   * what every server before this field was.
   */
  reactions: Schema.optional(Schema.Boolean),
  review: PullRequestReviewCapabilities,
  reviewers: PullRequestReviewerCapabilities,
  /**
   * What can be rewritten after the fact. Optional so a page and a server of different ages still
   * speak to each other: a server that says nothing about rewriting is one that cannot, which is
   * what every server before this one was.
   */
  edit: Schema.optional(PullRequestEditCapabilities),
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
  /**
   * The ways this viewer may bring the branch up to date, narrowed from what the host offers.
   * Absent or empty means they may not, which is also what a host with no such action says.
   */
  updateMethods: Schema.optional(Schema.Array(PullRequestUpdateMethod)),
});
export type PullRequestViewerPermissions = typeof PullRequestViewerPermissions.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
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
  /** Absent where the host does not summarise its reviews, which is every host but GitHub. */
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  /** Absent where the host reports no check rollup, or the change request has no checks. */
  checksState: Schema.optional(PullRequestChecksState),
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
  filters: Schema.optional(PullRequestListFilters),
  projectId: Schema.optional(ProjectId),
  /**
   * Only these projects, for a client that assigns each shared repository to one of its
   * connections and asks the others to stay quiet about it. Absent means every project, which
   * is what every listing asked for before there were several connections to spread across.
   */
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
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
   * Free text the hosts themselves are asked to match, rather than a filter over the rows that
   * have already arrived: a listing only ever holds a page per repository, so a search that
   * never leaves the client can only find what happened to be loaded. What a match means is the
   * host's own business — GitHub reads a body, GitLab a description — and a host with no text
   * filter answers unnarrowed rather than pretending.
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
  kind: SourceControlProviderKind,
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
 * The small live shape a linked thread needs. Keeping it separate from detail means a sidebar
 * status check never loads permissions, repository settings, checks, or base comparison data.
 */
export const PullRequestSummary = Schema.Struct({
  provider: SourceControlProviderKind,
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type PullRequestSummary = typeof PullRequestSummary.Type;

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
  provider: SourceControlProviderKind,
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
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  mergeCapabilities: PullRequestMergeCapabilities,
  /**
   * Who the host says the reader is, which is the one thing a conversation cannot be read without
   * to tell the reader's own remarks from everybody else's — and rewriting a remark is offered
   * only where the two names agree. Absent where the host could not say, which offers nothing
   * rather than everything.
   */
  viewer: Schema.optional(TrimmedNonEmptyString),
  /**
   * Where the branch stands against its base. Optional so a host that cannot compare says
   * nothing rather than claiming the branch is current — the page shows a banner only where the
   * answer is "behind", and silence is not that answer.
   */
  baseComparison: Schema.optional(PullRequestBaseComparison),
  /** How many commits the base is ahead by, where the host counted them. */
  behindBy: Schema.optional(NonNegativeInt),
  /**
   * Whether the host is already armed to merge this on its own. Absent where the host does not
   * report it, which is not the same as off: a page that reads silence as "not armed" offers to
   * arm something that is already armed, and a second arming is a write nobody asked for.
   */
  autoMergeEnabled: Schema.optional(Schema.Boolean),
  /** The strategy the host will use for an armed auto-merge, where it reports one. */
  autoMergeMethod: Schema.optional(PullRequestMergeMethod),
  /** GitHub Actions runs on this head commit that are waiting for a maintainer's approval. */
  workflowApprovalsRequired: Schema.optional(NonNegativeInt),
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
   * How many remarks the host itself counts in the conversation, which is the number a surface
   * showing a count has to show: `comments` carries what was read, and a reader who can see 225
   * on the host is not reassured by a page that says 10. Never less than `comments` holds, and
   * equal to it wherever the host was read to the end.
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
  /**
   * The change request's own reactions — the ones on its description, which every host counts
   * against the change request itself rather than against a remark in the conversation.
   */
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
});
export type PullRequestActivity = typeof PullRequestActivity.Type;

/** The complete detail shape after the independently loaded activity has been applied. */
export const PullRequestDetailView = Schema.Struct({
  ...PullRequestDetail.fields,
  ...PullRequestActivity.fields,
  // A composed view always has the core identity fields, even when the activity did not enrich
  // them. Re-declare them as required after the activity's optional overrides.
  author: Schema.NullOr(PullRequestActor),
  reviewers: Schema.Array(PullRequestActor),
});
export type PullRequestDetailView = typeof PullRequestDetailView.Type;

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

/** Real line counts for a file whose hunks the host withheld from the patch. */
export const PullRequestOmittedFileStat = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type PullRequestOmittedFileStat = typeof PullRequestOmittedFileStat.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  /**
   * Something inside this slice could not be shown — a binary file, or a hunk the host declined
   * to inline. Not the same as there being more slices, which `nextCursor` answers.
   */
  truncated: Schema.Boolean,
  /** Where the next slice starts, or null once the diff is whole. */
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The host's own counts for the files whose hunks it withheld, so a file the patch cannot
   * show still reports what changed instead of a zero the diff never had.
   */
  omittedFileStats: Schema.optional(Schema.Array(PullRequestOmittedFileStat)),
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

/** The complete old and new files Pierre needs to open omitted context in a host-backed patch. */
export const PullRequestDiffFileContentsInput = Schema.Struct({
  ...PullRequestRef.fields,
  /** One commit's own comparison; absent means the whole change request. */
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

export const PullRequestActionInput = Schema.Struct({
  ...PullRequestRef.fields,
  action: PullRequestAction,
  /**
   * Which strategy the merge uses, read for `merge` and for `enable-auto-merge` alike — a merge
   * the host performs later is still a merge, and the strategy is chosen when it is armed rather
   * than at the moment it happens. Absent means the host's own default.
   */
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  /** Only read for `update-branch`, where absent means the host's own default. */
  updateMethod: Schema.optional(PullRequestUpdateMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

// Not trimmed: the body is markdown, where leading spaces open a code block and two trailing
// spaces are a line break. GitHub rejects bodies past 65536 characters, so that bound is
// enforced here to keep oversized payloads off the wire and out of subprocess plumbing; the
// service rejects a body that is only whitespace.
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: CommentBody,
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

/**
 * A change request's own words rewritten: its title, its description, or both. Each is optional
 * because the page rewrites them apart — a title corrected on its own must not carry a description
 * nobody opened — and the service refuses a request that carries neither.
 *
 * The title is bounded far past what any host takes, GitHub refusing one past 256 characters, so
 * an oversized one is turned away before it reaches a subprocess. The body is not trimmed for the
 * same reason a comment is not: it is markdown, where leading spaces open a code block. An empty
 * one is allowed, which is how a description is cleared.
 */
export const PullRequestUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
});
export type PullRequestUpdateInput = typeof PullRequestUpdateInput.Type;

/**
 * A remark already posted, rewritten by whoever wrote it. The kind travels beside the id because
 * an id alone does not say which endpoint addresses it: GitHub rewrites a comment on the
 * conversation and a comment on a line through two different mutations.
 *
 * A review's own summary is not among them. The hosts disagree about what one even is — the entry
 * Bitbucket shows is a vote this page renders as a remark, with no words behind it to rewrite —
 * and a control that worked on one host and failed on another is worse than one that is not there.
 */
export const PullRequestCommentUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  commentId: TrimmedNonEmptyString,
  kind: Schema.Literals(["issue-comment", "review-comment"]),
  body: CommentBody,
});
export type PullRequestCommentUpdateInput = typeof PullRequestCommentUpdateInput.Type;

/** The coordinates of one line in a pull request diff. */
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
    /** Which copy of an unchanged line the reviewer selected in a split diff. */
    side: PullRequestDiffSide,
  }),
]);
export type PullRequestReviewPosition = typeof PullRequestReviewPosition.Type;

/** One remark in a review that has not been sent yet, anchored to a line of the diff. */
export const PullRequestReviewCommentDraft = Schema.Struct({
  path: TrimmedNonEmptyString,
  /**
   * What the file was called before the change, sent only when it differs. GitLab resolves a
   * position against both sides of the diff, so a comment on a renamed file needs both names;
   * the hosts that address a comment by one path ignore this.
   */
  oldPath: Schema.optional(TrimmedNonEmptyString),
  position: PullRequestReviewPosition,
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

/**
 * Reacting and taking the reaction back are one operation with `reacted` turned around, which is
 * what pressing the same pill twice is.
 */
export const PullRequestReactionInput = Schema.Struct({
  ...PullRequestRef.fields,
  /**
   * Which remark to react to, as it arrived in the conversation. Absent reacts to the change
   * request itself, which is where its description's reactions live — the id a host uses for
   * that is its own to work out.
   */
  subjectId: Schema.optional(TrimmedNonEmptyString),
  content: PullRequestReactionContent,
  reacted: Schema.Boolean,
});
export type PullRequestReactionInput = typeof PullRequestReactionInput.Type;

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
 * What each host needs before it can be read, so a failure names the fix rather than the
 * symptom. Bitbucket is credentials on the server rather than a signed-in CLI, which is why
 * these are whole sentences instead of a tool name to interpolate.
 */
const PROVIDER_REQUIREMENT: Partial<
  Record<SourceControlProviderKind, { readonly missing: string; readonly unauthenticated: string }>
> = {
  github: {
    missing:
      "GitHub CLI (`gh`) is required to browse change requests on this host. Install it from https://cli.github.com/ and reload.",
    unauthenticated: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  },
  gitlab: {
    missing:
      "GitLab CLI (`glab`) is required to browse change requests on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
    unauthenticated: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
  },
  "azure-devops": {
    missing:
      "Azure CLI (`az`) with the Azure DevOps extension is required. Install `az`, then run `az extension add --name azure-devops`.",
    unauthenticated: "Azure CLI is not signed in. Run `az login` and retry.",
  },
  bitbucket: {
    missing:
      "Bitbucket needs API credentials on the server. Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN, or T3CODE_BITBUCKET_ACCESS_TOKEN.",
    unauthenticated:
      "Bitbucket rejected the configured credentials. Check T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN.",
  },
};

/**
 * The host a project's repository is addressed below. `canonicalKey` is the normalized remote,
 * `host/owner/repo`, so its first segment is the host; the provider kind stands in when there is
 * no key to read, which keeps one bucket per kind for identities recorded before it existed.
 *
 * Shared between the server and the page so both bucket a workspace the same way — the page
 * knows its hosts before the listing answers, and the two must agree on what they are called.
 */
export function pullRequestHostOf(
  identity: { readonly canonicalKey?: string | undefined } | null | undefined,
  kind: SourceControlProviderKind,
): string {
  const host = identity?.canonicalKey?.split("/")[0]?.trim();
  return host === undefined || host.length === 0 ? kind : host.toLowerCase();
}

/**
 * `author:me` names whoever is signed in to the host being read, GitHub's `@me` spelled either
 * way. A host's own search would answer it, but the page and the server both re-check an author
 * against the row's login, so the name is resolved before either comparison rather than being
 * matched as the literal login "me".
 *
 * Null viewer where the host has not said who the reader is; the filter then stands as typed,
 * which is the same answer a search for a user named "me" would give.
 *
 * Shared between the server and the page so both narrow by the same login.
 */
export function resolvePullRequestAuthorFilter(
  author: string,
  viewer: string | null | undefined,
): string {
  const trimmed = author.trim();
  if (!/^@?me$/i.test(trimmed)) return trimmed;
  return viewer === null || viewer === undefined || viewer.trim().length === 0 ? trimmed : viewer;
}

/**
 * What a host needs before it can be read, as a sentence to show wherever that host is reported
 * as unusable — the whole page when nothing can be read, and one entry in the host switcher when
 * only that host cannot. Null when the reason is not about setting a host up.
 */
export function pullRequestProviderRequirement(
  provider: SourceControlProviderKind,
  reason: PullRequestUnavailableReason,
): string | null {
  const requirement = PROVIDER_REQUIREMENT[provider];
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
      this.provider === undefined ? undefined : PROVIDER_REQUIREMENT[this.provider];
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

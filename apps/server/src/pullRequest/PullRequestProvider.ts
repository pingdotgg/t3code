import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestBaseComparison,
  PullRequestCapabilities,
  PullRequestChecksState,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestLabelCandidateList,
  PullRequestState,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

/**
 * The one failure shape every provider reports, so the service can decide what a failure means
 * without knowing which CLI or API produced it.
 *
 * `reason` is the part the service acts on: a missing or unauthenticated tool disables the
 * provider for the whole workspace, a rate limit pauses its host, and anything else is specific
 * to the request.
 */
export class PullRequestProviderError extends Schema.TaggedErrorClass<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "rate-limited", "failed"]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export interface PullRequestProviderFailure {
  readonly reason: PullRequestProviderError["reason"];
  readonly retryAt?: number | undefined;
}

/** A change request as the provider sees it, before the service attaches project context. */
export interface ProviderChangeRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  /** Accounts with a review requested. Team-level requests are excluded by each provider. */
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  /** Absent from a host that does not summarise its reviews, which is every host but GitHub. */
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  /** Absent from a host that reports no check rollup on its listings. */
  readonly checksState?: PullRequestChecksState | null | undefined;
}

/** The fields needed to keep a linked thread's pull request status live. */
export interface ProviderChangeRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  /** Present when the host says an open pull request is still a draft. */
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
}

export interface ProviderChangeRequestPage {
  readonly items: ReadonlyArray<ProviderChangeRequest>;
  /** True when the host has more rows than the page size asked for. */
  readonly truncated: boolean;
  /**
   * Optional count-based cursor advance. Most hosts advance by the rows delivered after local
   * de-duplication; an offset-paged host may need to count malformed raw rows it consumed too.
   */
  readonly cursorAdvance?: number;
  /**
   * This page can be carried on from, so the service may hand the caller a cursor for it. False
   * where the host answered in an order a cursor means nothing in, which leaves a larger `limit`
   * as the only way to the rest — what every listing did before there were cursors.
   */
  readonly continues: boolean;
}

/**
 * Where a repository's next slice starts, as the provider that has to ask for it needs it. Built
 * by the service out of the slice it just handed over, so the boundary that decides whether a row
 * arrives twice or not at all is decided in one place rather than in four.
 */
export interface ProviderListCursor {
  /**
   * The instant of the oldest row already handed over, checked against a timestamp's shape before
   * it gets here because it goes into a host's own filter. Asked for inclusively: several rows
   * share one instant often enough — a bot that touches eight change requests writes one timestamp
   * on all eight — and asking for strictly older would lose whichever of them the slice ended
   * before. The service drops the ones it has already sent.
   */
  readonly updatedBefore: string;
  /**
   * How many provider rows this repository has consumed so far, for a host that carries on by
   * counting rather than by date. Usually this is the number handed over; malformed raw rows may
   * count too when the provider reports a `cursorAdvance`.
   */
  readonly delivered: number;
}

/** One repository's row inside an answer that spans several of them. */
export interface ProviderBatchedChangeRequest extends ProviderChangeRequest {
  /** Provider-native identity, exactly as it was asked for, so the caller can file the row. */
  readonly repository: string;
}

/**
 * One slice of a host read across several repositories at once, newest update first across all
 * of them. There is no per-repository page here because the host was asked one question: the
 * caller splits the rows by `repository` and works out where each of them carries on from the
 * oldest row in the slice, which every repository the slice covers is now read up to.
 */
export interface ProviderBatchedChangeRequestPage {
  readonly items: ReadonlyArray<ProviderBatchedChangeRequest>;
  /** True when the host has more rows than the slice asked for, for any of the repositories. */
  readonly truncated: boolean;
}

/** The line counts for one change request, which a listing may leave for a second read. */
export interface ProviderChangeRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly viewerPermissions: PullRequestViewerPermissions;
  /** Absent from a host that cannot compare the branch with its base, which is most of them. */
  readonly baseComparison?: PullRequestBaseComparison;
  readonly behindBy?: number;
  /** Absent from a host that does not report whether it is armed to merge this on its own. */
  readonly autoMergeEnabled?: boolean;
  /** The strategy stored with an armed auto-merge, where the host reports it. */
  readonly autoMergeMethod?: PullRequestMergeMethod;
  /** Workflow runs on this head commit that still need a maintainer's approval. */
  readonly workflowApprovalsRequired?: number;
}

/** The conversation-shaped half of a detail, loaded after the core can already render. */
export interface ProviderChangeRequestActivity {
  /** An optional richer actor, e.g. after GitHub's GraphQL read supplies an avatar. */
  readonly author?: PullRequestActor | null;
  /** Optional because most hosts already report their reviewer list in the core detail. */
  readonly reviewers?: ReadonlyArray<PullRequestActor>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  /**
   * The host's own count of the conversation, which a bounded read can fall short of. A host
   * that reports no count of its own answers with what it handed over, which is the same number
   * once the read went to the end.
   */
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  /** The change request's own reactions, from a host that has them. */
  readonly reactions?: ReadonlyArray<PullRequestReaction>;
}

export interface ProviderDiffSlice {
  readonly patch: string;
  /** Something in this slice could not be shown, as opposed to there being more slices. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  /** The host's own counts for the files whose hunks it withheld from this slice. */
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface ProviderDiffFileContents {
  readonly oldContents: string;
  readonly newContents: string;
}

export interface ProviderRepositoryRef {
  readonly cwd: string;
  /** Provider-native repository identity, e.g. `owner/repo` or `group/subgroup/project`. */
  readonly repository: string;
  /**
   * The host it lives on, which `repository` deliberately leaves out — the same `owner/repo`
   * exists on github.com and on a GitHub Enterprise install, and only the caller knows which
   * one a project's remote points at.
   */
  readonly host: string;
}

/**
 * One host's change requests. Implementations own their own tool and JSON shapes and hand back
 * the neutral types above; anything a host cannot do is declared in `capabilities` rather than
 * failing at call time.
 */
export interface PullRequestProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: PullRequestCapabilities;

  /** The signed-in account, which is what involvement filtering compares against. */
  readonly getViewer: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /**
       * Free text to narrow the listing by, as the host understands it. A host with no text
       * filter of its own ignores it and answers with the page it would have answered with
       * anyway — the caller narrows what it gets, so an unfiltered page is a wider answer
       * rather than a wrong one.
       */
      readonly query?: string | undefined;
      /**
       * Where to carry on from, rather than reading this repository from its newest row. Absent
       * asks for the first slice, which is every listing that has not been continued.
       */
      readonly cursor?: ProviderListCursor | undefined;
      /**
       * Further narrowings, which a host applies as far as it can and ignores the rest of —
       * an unnarrowed page is a wider answer rather than a wrong one, and the caller narrows
       * what it gets for the fields a row carries.
       */
      readonly filters?: PullRequestListFilters | undefined;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, PullRequestProviderError>;

  /**
   * The same listing for a whole host in one request, for a host that has a search across
   * repositories. Optional: three of the four hosts here have no such API, and breaking the port
   * for them to spare GitHub a fan-out would be paying for the fix with everyone else's clarity.
   * The caller falls back to `listChangeRequests` per repository where this is absent, and where
   * it fails.
   *
   * `limit` is the whole slice rather than a size per repository, because that is the shape of
   * the answer: the newest `limit` rows across every repository named, which is exactly the rows
   * a page ordered by update shows.
   *
   * `cursor` is one boundary for all of them, so a caller with repositories standing at different
   * boundaries asks in groups rather than in one call.
   */
  readonly listChangeRequestsAcross?: (input: {
    /** Any checkout on the host, which is what the tool is run in. */
    readonly cwd: string;
    readonly host: string;
    readonly repositories: ReadonlyArray<string>;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly filters?: PullRequestListFilters | undefined;
  }) => Effect.Effect<ProviderBatchedChangeRequestPage, PullRequestProviderError>;

  /**
   * The line counts for rows a listing has already handed over. Only implemented by a provider
   * whose listing leaves them out — for everyone else the numbers arrived with the row, and the
   * caller has nothing to ask for.
   */
  readonly listChangeRequestStats?: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly changeRequests: ReadonlyArray<{
      readonly repository: string;
      readonly number: number;
    }>;
  }) => Effect.Effect<ReadonlyArray<ProviderChangeRequestStat>, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  /**
   * The cheap live fields used by linked threads. Optional because a provider without a narrow
   * endpoint can fall back to its full detail read at the service boundary.
   */
  readonly getChangeRequestSummary?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestSummary, PullRequestProviderError>;

  /** Comments, line threads, and commits, kept off the critical path for the core detail. */
  readonly getChangeRequestActivity: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestActivity, PullRequestProviderError>;

  /** One explicit page after a reader asks to continue an unfinished review thread. */
  readonly getReviewThreadComments?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    },
  ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestProviderError>;

  /**
   * The same answer `getChangeRequest` carries, on its own. Asked before anything is written, so
   * a request that reached the server without going past the page is refused by what the host
   * says rather than by what the client claimed — and asked freshly, because access granted or
   * taken away since the page loaded is exactly the case this guards.
   *
   * Implementations read the cheapest thing that answers it, which for a host with nothing to say
   * is no request at all.
   */
  readonly getViewerPermissions: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestViewerPermissions, PullRequestProviderError>;

  /**
   * One slice of the patch. Only called when `capabilities.diff` is true. A provider that can
   * serve the whole diff at once answers with `nextCursor: null` and is done; one that pages
   * hands back whatever it needs to find the next slice.
   */
  readonly getDiff: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
      /** One commit's own changes, rather than everything the change request carries. */
      readonly commit?: string | undefined;
    },
  ) => Effect.Effect<ProviderDiffSlice, PullRequestProviderError>;

  /**
   * Full files at the exact revisions the host used for its patch. Optional where the provider
   * exposes no diff at all; the service refuses expansion there just as it refuses the patch.
   */
  readonly getDiffFileContents?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    },
  ) => Effect.Effect<ProviderDiffFileContents, PullRequestProviderError>;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      /** Meaningful for `merge` and `enable-auto-merge`; absent takes the host's own default. */
      readonly mergeMethod?: PullRequestMergeMethod;
      /** Only meaningful for `update-branch`; absent takes the host's own default. */
      readonly updateMethod?: PullRequestUpdateMethod;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Rewrites the change request's own words. Only called when `capabilities.edit.changeRequest`
   * is true, and never with both fields absent — the caller refuses that before it gets here,
   * because a host asked to change nothing answers differently on each of them.
   */
  readonly updateChangeRequest?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Rewrites a remark somebody already posted. Only called when `capabilities.edit.comment` is
   * true, with an id exactly as the conversation carried it.
   *
   * Whether this remark is the reader's to rewrite is the host's own answer: no read here can
   * settle it, since access can be taken away between the conversation being read and the
   * rewrite being sent, and a host refuses a stranger's remark with a sentence saying so.
   */
  readonly updateComment?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Sends a whole review at once. Only called for a verdict the host declared in
   * `capabilities.review.verdicts`, and with line comments only where it declared
   * `inlineComment`.
   */
  readonly submitReview: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * The people this viewer may ask for a review, with whoever has already been asked marked as
   * such. Only called when `capabilities.reviewers.listCandidates` is true.
   *
   * The author is left out by each provider rather than by the caller, because only the provider
   * knows how the host spells the same person in a candidate list and on a pull request.
   */
  readonly listReviewerCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestProviderError>;

  /**
   * Asks for a review, or takes the request back. Only called when
   * `capabilities.reviewers.request` is true.
   *
   * One call for both directions, because that is what every host does with them: GitHub posts and
   * deletes the same collection, and GitLab and Bitbucket write the whole reviewer set either way.
   * Asking again somebody who has already reviewed is a request like any other — which is how a
   * re-request is made.
   */
  readonly setReviewerRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * The repository's labels, with the ones already on the change request marked. Present with
   * `setLabels` only where `capabilities.labels` is true; the service refuses both without it.
   */
  readonly listLabelCandidates?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestLabelCandidateList, PullRequestProviderError>;

  /** Puts labels on the change request, or takes them off. One call for both directions. */
  readonly setLabels?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.review.reply` is true. */
  readonly replyToThread: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Adds a reaction, or takes it back. Only called when `capabilities.reactions` is true.
   *
   * `subjectId` is a remark's id as the conversation carried it; absent means the change request
   * itself, whose reactions sit on its description. Whatever a host needs to address either of
   * them is worked out here, because the id a conversation travels with is the one the reader has.
   */
  readonly setReaction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.review.resolve` is true. */
  readonly setThreadResolution: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly resolved: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;
}

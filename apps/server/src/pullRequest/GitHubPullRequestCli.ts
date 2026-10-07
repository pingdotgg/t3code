import { removeAgentCredits } from "./mergeMessage.ts";
import { KnownWorkflowRuns, makeChecksRevalidator } from "./gitHubConditionalChecks.ts";
import { runGitHubStackAction, type GitHubStackActionError } from "./githubStackActions.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  resolvePullRequestAuthorFilter,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestAction,
  type PullRequestStackHead,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestFileViewed,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestOmittedFileStat,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerKind,
  type PullRequestLabelCandidateList,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateMethod,
  type PullRequestPreview,
} from "@t3tools/contracts";

import { AllowGitHubReserve } from "../sourceControl/GitHubCli.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  ACTOR_AVATARS_GRAPHQL_QUERY,
  ADD_REACTION_GRAPHQL_MUTATION,
  buildReviewSubmission,
  buildReviewerRequest,
  buildSetFilesViewedGraphQlMutation,
  decodeActorAvatarsJson,
  decodePullRequestActivityJson,
  decodePullRequestCheckContextsJson,
  decodePullRequestCoreJson,
  decodeCommitFilesJson,
  pullRequestCheckContextsGraphQlQuery,
  pullRequestChecksFromContexts,
  pullRequestListGraphQlQuery,
  pullRequestSummaryGraphQlQuery,
  PULL_REQUEST_ACTIVITY_GRAPHQL_QUERY,
  PULL_REQUEST_HEADS_GRAPHQL_QUERY,
  decodeWorkflowRunsJson,
  type GitHubCheckContext,
  pullRequestCoreGraphQlQuery,
  type GitHubPullRequestCore,
  type GitHubPullRequestSummary,
  type GitHubPullRequestWatchFingerprint,
  decodePullRequestPreviewJson,
  PULL_REQUEST_PREVIEW_GRAPHQL_QUERY,
  decodePullRequestFilesJson,
  decodePullRequestFilesViewedJson,
  decodePullRequestHeadsJson,
  decodePullRequestListJson,
  decodePullRequestNodeIdJson,
  decodePullRequestSearchJson,
  decodePullRequestStacksJson,
  decodePullRequestStatsJson,
  decodePullRequestSummariesJson,
  decodePullRequestWatchFingerprintsJson,
  decodeReactionSubjectScopeJson,
  decodeReviewerCandidatesJson,
  decodeLabelCandidatesJson,
  buildLabelRequest,
  LABEL_CANDIDATES_GRAPHQL_QUERY,
  decodeReviewDismissalsJson,
  decodeReviewThreadCommentsJson,
  decodeReviewThreadsJson,
  buildPullRequestStatsGraphQlQuery,
  buildPullRequestSummariesGraphQlQuery,
  buildPullRequestWatchFingerprintsGraphQlQuery,
  buildPullRequestStackMembershipsGraphQlQuery,
  decodePullRequestStackMembershipsJson,
  pullRequestSearchGraphQlQuery,
  PULL_REQUEST_SEARCH_MAX_ROWS,
  PULL_REQUEST_FILES_VIEWED_GRAPHQL_QUERY,
  PULL_REQUEST_NODE_ID_GRAPHQL_QUERY,
  REACTION_SUBJECT_PULL_REQUEST_GRAPHQL_QUERY,
  REMOVE_REACTION_GRAPHQL_MUTATION,
  REVERT_PULL_REQUEST_GRAPHQL_MUTATION,
  gitHubReactionContent,
  RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  REVIEWER_CANDIDATES_GRAPHQL_QUERY,
  REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY,
  REVIEW_DISMISSALS_GRAPHQL_QUERY,
  REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
  REVIEW_THREADS_GRAPHQL_QUERY,
  reviewThreadConversation,
  UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION,
  UPDATE_PULL_REQUEST_GRAPHQL_MUTATION,
  UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION,
  VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  decodeViewerPermissionsJson,
  type GitHubPullRequestActivity,
  type GitHubPullRequestActivityPage,
  type GitHubWorkflowRunPage,
  type GitHubPullRequestHead,
  type GitHubPullRequestListItem,
  type GitHubPullRequestSearchItem,
  type GitHubPullRequestStack,
  type GitHubReviewThreadComments,
  type GitHubRepositoryAccess,
  type GitHubWorkflowRunApproval,
  type GitHubReviewThreadEntry,
  type GitHubReviewThreadPage,
  type GitHubViewerAccess,
} from "./gitHubPullRequestJson.ts";
import type { ProviderChangeRequestSummary, ProviderListCursor } from "./PullRequestProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitHubPullRequestReadError extends Schema.TaggedError<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub returned an unreadable ${this.operation} response.`;
  }
}

/** Not a decode failure: gh answered, the account it answered for just has no login. */
export class GitHubViewerLoginUnavailableError extends Schema.TaggedError<GitHubViewerLoginUnavailableError>()(
  "GitHubViewerLoginUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "GitHub returned no login for the authenticated account.";
  }
}

/** Not a decode failure: gh answered, but the pull request carried no update time. */
export class GitHubPullRequestUpdatedAtUnavailableError extends Schema.TaggedError<GitHubPullRequestUpdatedAtUnavailableError>()(
  "GitHubPullRequestUpdatedAtUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    repository: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `Pull request ${this.repository}#${this.number} reported no update time.`;
  }
}

/** Not a decode failure: the reader asked to carry on from a cursor this walk never handed out. */
export class GitHubDiffCursorError extends Schema.TaggedError<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The diff cursor was not one this pull request handed out.";
  }
}

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class GitHubDiffCommitError extends Schema.TaggedError<GitHubDiffCommitError>()(
  "GitHubDiffCommitError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The named commit was not a commit sha.";
  }
}

/** The revisions read successfully, but cannot name both sides this file needs. */
export class GitHubDiffRevisionsUnavailableError extends Schema.TaggedError<GitHubDiffRevisionsUnavailableError>()(
  "GitHubDiffRevisionsUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    number: Schema.Int,
    commit: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.commit === undefined
      ? `Pull request #${this.number} reported no usable base and head revisions.`
      : `Commit ${this.commit} reported no usable revisions for this file.`;
  }
}

/** A blob exists, but expanding it would be unsafe or would not produce text. */
export class GitHubDiffFileContentsUnavailableError extends Schema.TaggedError<GitHubDiffFileContentsUnavailableError>()(
  "GitHubDiffFileContentsUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary"]),
  },
) {
  override get message(): string {
    return this.reason === "oversized"
      ? `The diff file '${this.path}' exceeds the 1 MB expansion limit.`
      : `The diff file '${this.path}' is binary.`;
  }
}

/**
 * Not a decode failure: a repository was named that cannot go into a search or into a GraphQL
 * document as itself. Every qualifier and every alias below is composed from `owner/name`, so a
 * name that is not one is refused here rather than escaped into something GitHub might read as a
 * qualifier of its own.
 */
export class GitHubRepositorySelectorError extends Schema.TaggedError<GitHubRepositorySelectorError>()(
  "GitHubRepositorySelectorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "A repository was named that GitHub cannot address.";
  }
}

/** Not a decode failure: the reader named a subject this pull request never handed out. */
export class GitHubSubjectScopeError extends Schema.TaggedError<GitHubSubjectScopeError>()(
  "GitHubSubjectScopeError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "The named subject did not belong to the named pull request.";
  }
}

/** GitHub answered successfully, but approving every returned workflow would be unsafe. */
export class GitHubWorkflowApprovalRefusedError extends Schema.TaggedError<GitHubWorkflowApprovalRefusedError>()(
  "GitHubWorkflowApprovalRefusedError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    number: Schema.Int,
    reason: Schema.Literals(["head-list-truncated", "head-not-unique", "run-list-truncated"]),
    observedCount: Schema.Int,
    limit: Schema.Int,
  },
) {
  override get message(): string {
    if (this.reason === "head-list-truncated") {
      return `GitHub returned more than ${this.limit} pull requests for this head branch.`;
    }
    if (this.reason === "head-not-unique") {
      return `The head revision matched ${this.observedCount} pull requests instead of uniquely matching #${this.number}.`;
    }
    return `GitHub returned more than ${this.limit} workflow runs awaiting approval.`;
  }
}

/** GitHub omitted the immutable head identity needed to scope an approval safely. */
export class GitHubWorkflowApprovalHeadUnavailableError extends Schema.TaggedError<GitHubWorkflowApprovalHeadUnavailableError>()(
  "GitHubWorkflowApprovalHeadUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `GitHub did not report a complete head revision for #${this.number}.`;
  }
}

/** The pull request moved after its approval candidates were read. */
export class GitHubWorkflowApprovalHeadChangedError extends Schema.TaggedError<GitHubWorkflowApprovalHeadChangedError>()(
  "GitHubWorkflowApprovalHeadChangedError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `The head revision of #${this.number} changed before its workflows could be approved.`;
  }
}

export type GitHubPullRequestCliError =
  | GitHubStackActionError
  | GitHubApi.GitHubApiError
  | GitHubPullRequestReadError
  | GitHubDiffCursorError
  | GitHubDiffCommitError
  | GitHubDiffRevisionsUnavailableError
  | GitHubDiffFileContentsUnavailableError
  | GitHubRepositorySelectorError
  | GitHubSubjectScopeError
  | GitHubWorkflowApprovalRefusedError
  | GitHubWorkflowApprovalHeadUnavailableError
  | GitHubWorkflowApprovalHeadChangedError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | GitHubViewerLoginUnavailableError
  | GitHubPullRequestUpdatedAtUnavailableError;

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT = Duration.seconds(60);
/** Pierre expansion is for source files, not blobs large enough to stall a review surface. */
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** What `gh pr list --state` asked a repository's own list for, without search. */
const LIST_STATES: Record<PullRequestListState, ReadonlyArray<"OPEN" | "CLOSED" | "MERGED">> = {
  all: ["OPEN", "CLOSED", "MERGED"],
  open: ["OPEN"],
  // Closed includes merged here, the way GitHub's own list reads it; merged rows are filtered out
  // locally by `matchesUnsortedListing`.
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
};

interface GitHubPullRequestListPage {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly rawCount: number;
  readonly endCursor: string | null;
}

/** A search-free fallback may scan older rows for local filters, but never the whole repository. */
const PULL_REQUEST_FALLBACK_MAX_ROWS = 1_000;

/** What the files API serves at most in one response, which is what one slice is made of. */
const DIFF_FILES_PAGE_SIZE = 100;
/**
 * How many hundred-file pages of viewed state one read will walk. A point of the hourly GraphQL
 * budget per page, against a change request nobody reviews in one sitting past the first few
 * hundred files: beyond this the read stops and says it was cut short.
 */
const FILES_VIEWED_MAX_PAGES = 5;

/**
 * How many pull requests' node ids are remembered at once. A long-lived server sees far more of
 * them than a reader ever has open, and least recently used rather than first in: a listing
 * walking cold pull requests must not evict the review being ticked through.
 */
export const NODE_ID_CACHE_CAPACITY = 128;

/**
 * Pages of review threads to follow before the conversation is reported as truncated. GitHub
 * serves a hundred threads a page, so this is a thousand threads — past anything a pull request
 * a person is reading has, and short of walking a repository-sized conversation forever.
 */
const REVIEW_THREAD_PAGES = 10;

/** Pages of a hundred check contexts to walk for one head before the rollup says it was cut. */
const CHECK_CONTEXT_PAGES = 10;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
  /** False for a page GitHub would not search, which came back in `gh`'s own order instead. */
  readonly continues: boolean;
}

export interface GitHubPullRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Aliased lookups per request, and requests at once. Measured over a hundred rows: one request
 * carrying all hundred takes ~5.2s, four of twenty-five in parallel ~2.1s.
 */
const STAT_ALIASES_PER_REQUEST = 25;
const STAT_REQUEST_CONCURRENCY = 4;
/**
 * Summaries per aliased read. GitHub prices fifty at one point and seventy-five at two, and the
 * background sync that asks for them in bulk waits on no one, so it takes the slower ~2.2s read
 * of fifty over two reads of twenty-five.
 */
const SUMMARY_ALIASES_PER_REQUEST = 50;
/**
 * How long a summary read waits for company. The background sync asks for every linked pull
 * request at once, and each read reaches the resolver after its own cache check, so a batch
 * needs a moment longer than one scheduler tick to gather them.
 */
const SUMMARY_BATCH_WINDOW = "10 millis";

class PullRequestSummaryRead extends Request.Class<
  {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  },
  ProviderChangeRequestSummary,
  GitHubPullRequestCliError
> {}

class PullRequestWatchFingerprintRead extends Request.Class<
  {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  },
  GitHubPullRequestWatchFingerprint | null,
  GitHubPullRequestCliError
> {}

export interface GitHubPullRequestSearchBatch {
  /** Rows across every repository asked for, newest update first, each naming its own. */
  readonly items: ReadonlyArray<GitHubPullRequestSearchItem>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestDiffSlice {
  readonly patch: string;
  /** Files in this slice had their hunks withheld, as opposed to there being more slices. */
  readonly truncated: boolean;
  /** Where the next slice starts, or null once the patch is whole. */
  readonly nextCursor: string | null;
  /** GitHub's own counts for the files whose hunks it withheld from this slice. */
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface GitHubPullRequestFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  /** GitHub had more files than the page budget below would read. */
  readonly truncated: boolean;
}

export class GitHubPullRequestCli extends Context.Service<
  GitHubPullRequestCli,
  {
    readonly withVerifiedCredential: <A, E, R>(
      input: { readonly cwd: string; readonly host: string },
      use: (identity: {
        readonly accountId: string;
        readonly viewer: string;
        readonly credentialFingerprint: string;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubPullRequestCliError, R>;
    readonly getRoutingIdentity: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<
      { readonly accountId: string; readonly viewer: string },
      GitHubPullRequestCliError
    >;
    readonly getViewerLogin: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<string, GitHubPullRequestCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text for `--search`, matched as one literal phrase. */
      readonly query?: string | undefined;
      /** Where to carry on from, as a `updated:` qualifier on the same search. */
      readonly cursor?: ProviderListCursor | undefined;
      /** Further narrowings, as qualifiers on the search and as a local pass on the fallback. */
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestCliError>;

    /**
     * The same listing for a whole host in one search. `limit` is the size of the slice across
     * all of the repositories rather than per repository, because that is what a search answers:
     * the newest rows of the lot, which is exactly the page.
     */
    readonly searchPullRequests: (input: {
      /** Any checkout on the host; the search names its repositories itself. */
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
    }) => Effect.Effect<GitHubPullRequestSearchBatch, GitHubPullRequestCliError>;

    /** The line counts the search leaves out, for rows already on the page. */
    readonly listPullRequestStats: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestStat>, GitHubPullRequestCliError>;

    readonly getPullRequestSummary: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<ProviderChangeRequestSummary, GitHubPullRequestCliError>;
    /**
     * What a watch compares between passes, batched like summaries. Null when GitHub gave no
     * answer for this pull request, so the watch reads it in full instead.
     */
    readonly getPullRequestWatchFingerprint: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestWatchFingerprint | null, GitHubPullRequestCliError>;

    readonly revalidateChecks: Effect.Success<typeof makeChecksRevalidator>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestCore, GitHubPullRequestCliError>;

    readonly getPullRequestPreview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<
      Omit<PullRequestPreview, "projectId" | "repository">,
      GitHubPullRequestCliError
    >;

    readonly listWorkflowRunsRequiringApproval: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly headSha: string;
      readonly headBranch: string;
      readonly headRepositoryOwner: string;
      readonly isCrossRepository: true;
    }) => Effect.Effect<ReadonlyArray<GitHubWorkflowRunApproval>, GitHubPullRequestCliError>;

    /**
     * The host-native stack this pull request is in, or null when it is in none — which is also
     * the answer for a host that refuses the stacks preview altogether.
     */
    readonly getPullRequestStack: (input: {
      readonly cwd: string;
      readonly includeDetails?: boolean;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestStack | null, GitHubPullRequestCliError>;

    readonly getPullRequestActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestActivity, GitHubPullRequestCliError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Absent asks for the first slice; anything else is a cursor a slice handed back. */
      readonly cursor?: string | undefined;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestCliError>;

    readonly getPullRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitHubPullRequestCliError
    >;

    /**
     * Which files of the pull request the signed-in account has cleared, and which of those have
     * been pushed to since. Read apart from the patch because GitHub only reports it over GraphQL.
     */
    readonly getPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestFilesViewed, GitHubPullRequestCliError>;

    /**
     * Clears files, or puts them back, as one request. GitHub takes a single path per mutation,
     * so a burst is batched with aliases into one document rather than one subprocess per press.
     */
    readonly setPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestCliError>;

    /** One request for a listing's authors, since no `gh` JSON field reports an avatar. */
    readonly listActorAvatars: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitHubPullRequestCliError>;

    readonly getReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    }) => Effect.Effect<PullRequestThreadCommentsResult, GitHubPullRequestCliError>;

    /** The viewer's standing on its own, for deciding a write without reading the whole detail. */
    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Manual action checks may use the quota held back from automatic reads. */
      readonly allowReserve?: boolean | undefined;
    }) => Effect.Effect<GitHubViewerAccess & GitHubRepositoryAccess, GitHubPullRequestCliError>;

    /** Who this pull request may be sent to, and who it has already been sent to. */
    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitHubPullRequestCliError>;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      /** False deletes the same collection a request posts to, which takes the request back. */
      readonly requested: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    /** The repository's labels, and which of them this pull request already wears. */
    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, GitHubPullRequestCliError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      /** False takes each label off; true adds each to whatever is already there. */
      readonly applied: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly stackNumber?: number;
      readonly expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
      readonly removeAgentCreditsOnMerge?: boolean;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly replyToReviewThread: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly setReviewThreadResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    /**
     * Adds a reaction to a remark, or takes it back. `subjectId` is any node GitHub calls
     * reactable — a comment, a review, or the pull request itself, which is looked up here
     * because nothing in the conversation names it. A given `subjectId` is confirmed to belong
     * to this pull request before the mutation runs, since nothing else ties the two together.
     */
    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    /** Rewrites the pull request's own words, leaving whichever of the two was not given. */
    readonly updatePullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    /**
     * Rewrites a remark. `commentId` is trusted to be whatever node it names, so it is confirmed
     * to belong to this pull request before the mutation runs, the way a reaction subject is.
     * Whether the remark is the reader's to rewrite is GitHub's own answer, not one asked here.
     */
    readonly updateComment: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;
  }
>()("t3/pullRequest/GitHubPullRequestCli") {}

/**
 * The GraphQL API takes owner and name as separate arguments, so `owner/repo` is split here.
 * The host is not read off the identity: it travels alongside it, because the identity a
 * project records is the path below its host and never names the host itself.
 */
function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/**
 * The page a diff cursor names, or null for anything this walk cannot have issued. The cursor
 * arrives from the reader as a string and goes straight into a request path, so it is parsed
 * rather than trusted; the length bound keeps a page number out of exponential notation.
 */
function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

/**
 * A commit sha arrives from the reader and goes straight into a request path, so it is checked
 * rather than trusted: hexadecimal only, from the shortest abbreviation a host prints up to a
 * whole sha.
 */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/**
 * The reader's own words as one literal phrase of a GitHub search query. Quoting is the whole
 * defence: outside quotes GitHub reads `is:merged` as a qualifier and `label:x` as another, so
 * text typed into a search box could widen the very listing it is meant to narrow — inside them
 * it is only text. The two characters that could end the phrase early are therefore escaped
 * first, which GitHub reads back as themselves; an unbalanced quote is dropped instead, which
 * would let everything after it out of the phrase.
 *
 * The phrase is one argv element, so nothing in it can become a flag of its own either.
 */
function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** GitHub's own spelling of a review state, which is not the contract's. */
const REVIEW_QUALIFIERS = {
  approved: "approved",
  "changes-requested": "changes_requested",
  "review-required": "required",
  none: "none",
} as const;

/**
 * The extra narrowings as GitHub search qualifiers. Values a reader typed are quoted, and the
 * one character that could end the quoted value early is dropped rather than escaped: no GitHub
 * label or login holds a double quote, so there is nothing to preserve and everything to lose.
 */
function qualifierValue(value: string): string {
  return `"${value.replaceAll('"', "").trim()}"`;
}

function filterQualifiers(
  filters: PullRequestListFilters | undefined,
  viewer: string,
): ReadonlyArray<string> {
  if (filters === undefined) return [];
  return [
    // One qualifier per group, its names joined by commas — GitHub's own OR.
    ...(filters.labels ?? []).flatMap((group) =>
      group.length === 0 ? [] : [`label:${group.map(qualifierValue).join(",")}`],
    ),
    ...(filters.excludedLabels ?? []).map((label) => `-label:${qualifierValue(label)}`),
    ...(filters.author === undefined
      ? []
      : [`author:${qualifierValue(resolvePullRequestAuthorFilter(filters.author, viewer))}`]),
    ...(filters.draft === undefined ? [] : [`draft:${filters.draft === "only"}`]),
    ...(filters.review === undefined ? [] : [`review:${REVIEW_QUALIFIERS[filters.review]}`]),
    ...(filters.checks === undefined
      ? []
      : [`status:${filters.checks === "passing" ? "success" : "failure"}`]),
  ];
}

/**
 * The same narrowings over a row that has already arrived, for the search-free fallback. Every
 * listed row now carries its own `checksState`, so `checks` is judged the way `review` is: by
 * equality against the row's field. Unlike `review`, `checks` has no `"none"` value to catch an
 * absent state on purpose — a row with no checks configured, or whose checks are still `pending`,
 * equals neither `"passing"` nor `"failing"` and so fails both, the same as a row search would
 * not have surfaced for `status:success` or `status:failure`.
 */
function matchesFilters(
  item: GitHubPullRequestListItem,
  filters: PullRequestListFilters | undefined,
  viewer: string,
): boolean {
  if (filters === undefined) return true;
  const labels = new Set(item.labels.map((label) => label.name.trim().toLowerCase()));
  const holds = (label: string) => labels.has(label.trim().toLowerCase());
  return (
    (filters.draft === undefined || item.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? item.reviewDecision === null
        : item.reviewDecision === filters.review)) &&
    (filters.checks === undefined || item.checksState === filters.checks) &&
    (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      item.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

/** The search-free fallback is wider than the request, so narrow its decoded rows locally. */
function matchesUnsortedListing(
  item: GitHubPullRequestListItem,
  input: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly filters?: PullRequestListFilters | undefined;
  },
): boolean {
  const matchesState = input.state === "all" || item.state === input.state;
  const viewer = input.viewer.toLowerCase();
  const matchesInvolvement =
    input.involvement === "all" ||
    (input.involvement === "authored"
      ? item.author?.login.toLowerCase() === viewer
      : item.hasTeamReviewRequest ||
        item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer));
  return matchesState && matchesInvolvement && matchesFilters(item, input.filters, input.viewer);
}

/** What a repository selector may hold before it goes into a search as itself. */
const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * A listing as one GitHub search, across one repository or several: the only way to read a
 * whole host in one request, and the only order (`updated`) a continuation can carry on from.
 *
 * `--state closed` in GitHub's own list includes merged pull requests, so the Closed tab is
 * `is:closed is:unmerged` here.
 *
 * Null where a repository is not `owner/name`. A name is written into the query as itself, and a
 * name holding a space could otherwise end the `repo:` qualifier and start a qualifier of its
 * own — so an unaddressable one refuses the whole read rather than being escaped into something
 * GitHub might still read.
 */
function searchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly cursor?: ProviderListCursor | undefined;
  readonly filters?: PullRequestListFilters | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  const query = input.query?.trim() ?? "";
  return [
    "is:pr",
    // "all" is every state, which `is:pr` already is.
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed", "is:unmerged"] : []),
    ...(input.state === "merged" ? ["is:merged"] : []),
    ...(input.involvement === "authored" ? [`author:${input.viewer}`] : []),
    ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    // Inclusive, and de-duplicated by the caller, for the reason the per-repository read gives.
    ...(input.cursor === undefined ? [] : [`updated:<=${input.cursor.updatedBefore}`]),
    ...filterQualifiers(input.filters, input.viewer),
    // The order the page reads its rows in, and the only order a continuation can carry on from.
    "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

const MERGE_MESSAGE_GRAPHQL_QUERY = `
query PullRequestMergeMessage($owner: String!, $name: String!, $number: Int!, $method: PullRequestMergeMethod!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      isMergeQueueEnabled
      headRefOid
      viewerMergeBodyText(mergeType: $method)
    }
  }
}`;

/** The two revisions a file is expanded between: a pull request's base and head, or a commit's parent and itself. */
const decodeRevisionRefs = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      sha: Schema.optional(Schema.String),
      parents: Schema.optional(Schema.Array(Schema.Struct({ sha: Schema.String }))),
      base: Schema.optional(Schema.Struct({ sha: Schema.String })),
      head: Schema.optional(Schema.Struct({ sha: Schema.String })),
    }),
  ),
);

const decodeMergeMessageResponse = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            isMergeQueueEnabled: Schema.Boolean,
            headRefOid: Schema.String,
            viewerMergeBodyText: Schema.String,
          }),
        }),
      }),
    }),
  ),
);
const decodeMergeMessage = (raw: string) =>
  Result.map(decodeMergeMessageResponse(raw), (response) => response.data.repository.pullRequest);

/** What `gh pr merge` and `gh pr update-branch` read before they act. */
const ACTION_STATE_GRAPHQL_QUERY = `
query PullRequestActionState($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
      isMergeQueueEnabled
      mergeStateStatus
      baseRef { compare(headRef: $headRef) { behindBy } }
    }
  }
}`;

const decodeActionStateResponse = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            id: Schema.String,
            headRefOid: Schema.String,
            isMergeQueueEnabled: Schema.optional(Schema.Boolean),
            mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
            baseRef: Schema.optional(
              Schema.NullOr(
                Schema.Struct({ compare: Schema.NullOr(Schema.Struct({ behindBy: Schema.Int })) }),
              ),
            ),
          }),
        }),
      }),
    }),
  ),
);
const decodeActionState = (raw: string) =>
  Result.map(decodeActionStateResponse(raw), (response) => response.data.repository.pullRequest);

const MERGE_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { clientMutationId }
}`;
const ENABLE_AUTO_MERGE_GRAPHQL_MUTATION = `mutation($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) { clientMutationId }
}`;
const DISABLE_AUTO_MERGE_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const UPDATE_BRANCH_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $updateMethod: PullRequestBranchUpdateMethod!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: $updateMethod }) { clientMutationId }
}`;
const READY_FOR_REVIEW_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const CONVERT_TO_DRAFT_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const CLOSE_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const REOPEN_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  reopenPullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const ADD_COMMENT_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
}`;

const GRAPHQL_MERGE_METHODS = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
} as const satisfies Record<PullRequestMergeMethod, string>;

/** States in which `gh pr merge --auto` merges at once instead of arming auto-merge. */
const IMMEDIATELY_MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** The mutations that only need the pull request's node id. */
const SIMPLE_ACTION_MUTATIONS = {
  "disable-auto-merge": DISABLE_AUTO_MERGE_GRAPHQL_MUTATION,
  ready: READY_FOR_REVIEW_GRAPHQL_MUTATION,
  draft: CONVERT_TO_DRAFT_GRAPHQL_MUTATION,
  close: CLOSE_PULL_REQUEST_GRAPHQL_MUTATION,
  reopen: REOPEN_PULL_REQUEST_GRAPHQL_MUTATION,
} as const satisfies Partial<Record<PullRequestAction, string>>;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const revalidateChecks = yield* makeChecksRevalidator;
  const routingIdentities = new Map<
    string,
    {
      at: number;
      value: { accountId: string; viewer: string };
    }
  >();
  const identityLocks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();
  const decodeRoutingIdentity = Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        id: PositiveInt,
        login: TrimmedNonEmptyString,
      }),
    ),
  );
  const captureVerifiedCredential = Effect.fn("GitHubPullRequestCli.captureVerifiedCredential")(
    function* (input: { readonly cwd: string; readonly host: string }) {
      const unavailable = () =>
        new GitHubViewerLoginUnavailableError({ command: "gh", cwd: input.cwd });
      const host = input.host.toLowerCase();
      // A missing or signed-out credential keeps its own error, so the page can say which.
      const { token, fingerprint: key } = yield* api.credential(host);
      const credential = { host, token, credentialFingerprint: key };
      // A cold page may ask several times. Wait per credential and check again after the
      // first verification; cancellation releases the next waiter without losing its request.
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = identityLocks.get(key) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
          lock.users++;
          identityLocks.set(key, lock);
          return lock;
        }),
        (lock) =>
          lock.gate.withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const cached = routingIdentities.get(key);
              if (cached !== undefined && now - cached.at < 10 * 60_000)
                return { ...credential, ...cached.value };
              // Pin this read so an auth switch cannot poison its cache entry.
              const response = yield* api
                .rest({ host, operation: "getRoutingIdentity", path: "user", allowReserve: true })
                .pipe(
                  Effect.provideService(GitHubApi.PinnedGitHubCredential, credential),
                  Effect.provideService(SourceControlRateLimit.CredentialScope, key),
                );
              const identity = yield* decodeRoutingIdentity(response.body).pipe(
                Effect.mapError(unavailable),
              );
              const value = { accountId: String(identity.id), viewer: identity.login };
              if (routingIdentities.size >= 128)
                routingIdentities.delete(routingIdentities.keys().next().value!);
              routingIdentities.set(key, { at: now, value });
              return { ...credential, ...value };
            }),
          ),
        (lock) =>
          Effect.sync(() => {
            lock.users--;
            if (lock.users === 0) identityLocks.delete(key);
          }),
      );
    },
  );
  const withVerifiedCredential: GitHubPullRequestCli["Service"]["withVerifiedCredential"] = (
    input,
    use,
  ) =>
    captureVerifiedCredential(input).pipe(
      Effect.flatMap(({ host, token, accountId, viewer, credentialFingerprint }) =>
        use({ accountId, viewer, credentialFingerprint }).pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, credentialFingerprint),
          Effect.provideService(GitHubApi.PinnedGitHubCredential, {
            host,
            token,
            credentialFingerprint,
          }),
        ),
      ),
    );
  const getRoutingIdentity: GitHubPullRequestCli["Service"]["getRoutingIdentity"] = (input) =>
    captureVerifiedCredential(input).pipe(
      Effect.map(({ accountId, viewer }) => ({ accountId, viewer })),
    );

  /**
   * The pull request's own node id, which is what a mutation against the pull request itself is
   * addressed by: a reaction on its description, or a rewrite of its words.
   *
   * A pull request keeps its node id for life, so it is remembered rather than re-read: a reader
   * ticking files viewed would otherwise pay a GraphQL round trip per press.
   */
  const nodeIds = new Map<string, string>();

  const pullRequestNodeId = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly operation: string;
  }): Effect.Effect<string, GitHubPullRequestCliError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const key = `${input.host} ${owner}/${name} ${input.number}`;
    const held = nodeIds.get(key);
    if (held !== undefined) {
      // Put back at the end on every hit, so what falls out is the pull request nobody has looked
      // at rather than the one being ticked through: a run of cold reads would otherwise evict the
      // open review and make it pay a round trip per press.
      nodeIds.delete(key);
      nodeIds.set(key, held);
      return Effect.succeed(held);
    }
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: input.operation,
      allowReserve: true,
      variables: { owner, name, number: input.number },
      query: PULL_REQUEST_NODE_ID_GRAPHQL_QUERY,
      decode: decodePullRequestNodeIdJson,
    }).pipe(
      Effect.tap((nodeId) =>
        Effect.sync(() => {
          if (nodeIds.size >= NODE_ID_CACHE_CAPACITY) {
            const oldest = nodeIds.keys().next().value;
            if (oldest !== undefined) nodeIds.delete(oldest);
          }
          nodeIds.set(key, nodeId);
        }),
      ),
    );
  };

  /**
   * Whether a client-given subject actually belongs to the pull request the request names. A
   * subject id is trusted to be whatever node it names, and that node can hang off any pull
   * request on the host — so the mutation itself would write wherever the id actually belongs,
   * not wherever the request says it does, unless this confirms the two agree first.
   */
  const subjectBelongsToPullRequest = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly subjectId: string;
    readonly operation: string;
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: input.operation,
      allowReserve: true,
      variables: { owner, name, number: input.number, subjectId: input.subjectId },
      query: REACTION_SUBJECT_PULL_REQUEST_GRAPHQL_QUERY,
      decode: decodeReactionSubjectScopeJson,
    });
  };

  /** A GraphQL mutation whose answer is not read back; a GraphQL error fails it. */
  const graphql = (input: {
    readonly host: string;
    readonly operation: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }) => api.graphql(input).pipe(Effect.asVoid);

  const readError = (cwd: string, operation: string, cause: unknown) =>
    new GitHubPullRequestReadError({ command: "gh", cwd, operation, cause });

  /** Decodes an answer, reporting a failure against the read that made it. */
  const decodeWith = <A>(
    cwd: string,
    operation: string,
    decode: (raw: string) => Result.Result<A, unknown>,
    raw: string,
  ): Effect.Effect<A, GitHubPullRequestReadError> => {
    const decoded = decode(raw.trim());
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail(readError(cwd, operation, decoded.failure));
  };

  /** A GraphQL read whose answer is decoded, reporting a failure against the read that made it. */
  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly allowReserve?: boolean | undefined;
    readonly variables?: Readonly<Record<string, unknown>>;
    readonly query: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubPullRequestCliError> =>
    api
      .graphql({
        host: input.host,
        operation: input.operation,
        query: input.query,
        ...(input.variables === undefined ? {} : { variables: input.variables }),
        ...(input.allowReserve === true ? { allowReserve: true } : {}),
      })
      .pipe(Effect.flatMap((raw) => decodeWith(input.cwd, input.operation, input.decode, raw)));

  /** A REST read whose JSON answer is decoded the same way. */
  const restRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly path: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubPullRequestCliError> =>
    api
      .rest({ host: input.host, operation: input.operation, path: input.path })
      .pipe(
        Effect.flatMap((response) =>
          decodeWith(input.cwd, input.operation, input.decode, response.body),
        ),
      );

  /**
   * One page of the patch, read from the files API. GitHub refuses a whole diff past 300 changed
   * files, and still serves those files' hunks here.
   *
   * A page is a whole number of files, so each one parses on its own; the caller carries on from
   * `nextCursor` for as long as GitHub keeps handing pages back.
   *
   * A named commit is read from the commit endpoint, which lists the same file entries and pages
   * them the same way, only wrapped in an object.
   */
  const diffFilesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestCliError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const paging = `per_page=${DIFF_FILES_PAGE_SIZE}&page=${input.page}`;
    return api
      .rest({
        host: input.host,
        operation: "getPullRequestDiff",
        path:
          input.commit === undefined
            ? `repos/${owner}/${name}/pulls/${input.number}/files?${paging}`
            : `repos/${owner}/${name}/commits/${input.commit}?${paging}`,
        maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
        timeout: DIFF_TIMEOUT,
      })
      .pipe(
        Effect.flatMap((response) => {
          // Checked before decoding: a byte-truncated response is a JSON prefix, which would
          // fail to parse. Nothing of this page can be shown, and an empty patch would render
          // as a change with no files rather than as the failure it is; slices already handed
          // over stay with the reader either way.
          if (response.truncated) {
            return Effect.fail(
              readError(
                input.cwd,
                "getPullRequestDiff",
                new Error(`Page ${input.page} of the changed files was too large to read.`),
              ),
            );
          }
          return decodeWith(
            input.cwd,
            "getPullRequestDiff",
            input.commit === undefined ? decodePullRequestFilesJson : decodeCommitFilesJson,
            response.body,
          );
        }),
        Effect.map((files) => {
          // Counted before decoding, so a page whose files all failed to decode still moves on
          // rather than pointing the reader back at the page it just read.
          const morePages = files.rawCount >= DIFF_FILES_PAGE_SIZE;
          return {
            patch: files.patch,
            truncated: files.truncated,
            nextCursor: morePages ? String(input.page + 1) : null,
            ...(files.omittedFileStats.length === 0
              ? {}
              : { omittedFileStats: files.omittedFileStats }),
          };
        }),
      );
  };

  const getPullRequestDiffFileContents: GitHubPullRequestCli["Service"]["getPullRequestDiffFileContents"] =
    (input) =>
      Effect.gen(function* () {
        if (input.commit !== undefined && !isCommitSha(input.commit)) {
          return yield* new GitHubDiffCommitError({ command: "gh", cwd: input.cwd });
        }
        const { owner, name } = parseRepositorySelector(input.repository);
        const refsResponse = yield* api.rest({
          host: input.host,
          operation: "getPullRequestDiffFileContents",
          path:
            input.commit === undefined
              ? `repos/${owner}/${name}/pulls/${input.number}`
              : `repos/${owner}/${name}/commits/${input.commit}`,
          timeout: DIFF_TIMEOUT,
        });
        const refs = decodeRevisionRefs(refsResponse.body);
        // A root commit has no parent, which is an absent old revision. Every file in it is new,
        // so that is a usable answer whenever the caller does not need the old side.
        const baseRef = Option.isSome(refs)
          ? input.commit === undefined
            ? refs.value.base?.sha
            : (refs.value.parents?.[0]?.sha ?? "")
          : undefined;
        const headRef = Option.isSome(refs)
          ? input.commit === undefined
            ? refs.value.head?.sha
            : refs.value.sha
          : undefined;
        const rootCommitNewFile =
          input.commit !== undefined && input.changeType === "new" && baseRef === "";
        if (
          headRef === undefined ||
          (!rootCommitNewFile && (baseRef === undefined || !isCommitSha(baseRef))) ||
          !isCommitSha(headRef)
        ) {
          return yield* new GitHubDiffRevisionsUnavailableError({
            command: "gh",
            cwd: input.cwd,
            number: input.number,
            ...(input.commit === undefined ? {} : { commit: input.commit }),
          });
        }

        const readFile = (revision: string, filePath: string) =>
          api
            .rest({
              host: input.host,
              operation: "getPullRequestDiffFileContents",
              accept: "application/vnd.github.raw+json",
              path: `repos/${owner}/${name}/contents/${filePath
                .split("/")
                .map(encodeURIComponent)
                .join("/")}?ref=${encodeURIComponent(revision)}`,
              maxResponseBytes: DIFF_FILE_MAX_OUTPUT_BYTES,
              timeout: DIFF_TIMEOUT,
            })
            .pipe(
              Effect.flatMap((response) =>
                response.truncated || response.body.includes("\0") || response.invalidUtf8
                  ? Effect.fail(
                      new GitHubDiffFileContentsUnavailableError({
                        command: "gh",
                        cwd: input.cwd,
                        path: filePath,
                        reason: response.truncated ? "oversized" : "binary",
                      }),
                    )
                  : Effect.succeed(response.body),
              ),
            );

        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new"
              ? Effect.succeed("")
              : readFile(baseRef ?? "", input.oldPath),
            input.changeType === "deleted" ? Effect.succeed("") : readFile(headRef, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      });

  /**
   * Every check context of the head commit, a page at a time, for a rollup the detail read cut at
   * its first hundred. Each page names the head it read, so a push mid-walk fails rather than
   * mixing two revisions' checks.
   */
  const readAllCheckContexts = (
    input: Parameters<GitHubPullRequestCli["Service"]["getPullRequestDetail"]>[0],
    allowReserve: boolean,
  ) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepositorySelector(input.repository);
      const contexts: GitHubCheckContext[] = [];
      let headSha: string | null = null;
      let after: string | null = null;
      for (let page = 0; page < CHECK_CONTEXT_PAGES; page++) {
        const read: {
          readonly headSha: string;
          readonly contexts: ReadonlyArray<GitHubCheckContext>;
          readonly nextCursor: string | null;
        } = yield* graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "getPullRequestDetail",
          allowReserve,
          variables: { owner, name, number: input.number, after },
          query: pullRequestCheckContextsGraphQlQuery(input.host),
          decode: decodePullRequestCheckContextsJson,
        });
        if (headSha !== null && read.headSha !== headSha) {
          return yield* readError(
            input.cwd,
            "getPullRequestDetail",
            new Error("Pull request head changed while reading checks."),
          );
        }
        headSha = read.headSha;
        contexts.push(...read.contexts);
        after = read.nextCursor;
        if (after === null) break;
      }
      return { headSha, contexts, truncated: after !== null };
    });

  const getPullRequestDetail: GitHubPullRequestCli["Service"]["getPullRequestDetail"] = (input) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return AllowGitHubReserve.pipe(
      Effect.flatMap((allowReserve) =>
        graphqlRead({
          allowReserve,
          cwd: input.cwd,
          host: input.host,
          operation: "getPullRequestDetail",
          variables: {
            owner,
            name,
            number: input.number,
            headRef: `refs/pull/${input.number}/head`,
          },
          query: pullRequestCoreGraphQlQuery(input.host),
          decode: decodePullRequestCoreJson,
        }).pipe(
          // Past a hundred checks the first page would let the rest imply success, so the whole
          // rollup is walked instead.
          Effect.filterOrElse(
            (core) => !core.checksTruncated,
            (core) =>
              readAllCheckContexts(input, allowReserve).pipe(
                Effect.filterOrFail(
                  (all) => all.headSha === core.headSha,
                  () =>
                    readError(
                      input.cwd,
                      "getPullRequestDetail",
                      new Error("Pull request head changed while reading checks."),
                    ),
                ),
                Effect.map((all) => ({
                  ...core,
                  ...pullRequestChecksFromContexts(all.contexts),
                  checksTruncated: all.truncated,
                })),
              ),
          ),
        ),
      ),
    );
  };

  const workflowApprovalLimit = 1_000;
  const workflowApprovalReadError = (cwd: string, cause: unknown) =>
    readError(cwd, "listWorkflowRunsRequiringApproval", cause);

  /** Every open pull request whose head branch carries this name, up to one past the limit. */
  const listHeadsByBranch = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly headBranch: string;
  }) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepositorySelector(input.repository);
      const heads: GitHubPullRequestHead[] = [];
      let after: string | null = null;
      do {
        const page: {
          readonly heads: ReadonlyArray<GitHubPullRequestHead>;
          readonly nextCursor: string | null;
        } = yield* graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "listWorkflowRunsRequiringApproval",
          allowReserve: true,
          variables: { owner, name, head: input.headBranch, after },
          query: PULL_REQUEST_HEADS_GRAPHQL_QUERY,
          decode: decodePullRequestHeadsJson,
        });
        heads.push(...page.heads);
        after = page.nextCursor;
      } while (after !== null && heads.length <= workflowApprovalLimit);
      return heads;
    });

  /**
   * The runs waiting on a maintainer for this exact head, up to one past the limit. `head_sha` is
   * what scopes them; `head_branch` is checked as well, the way `gh run list --branch` did.
   */
  const listActionRequiredRuns = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly headSha: string;
    readonly headBranch: string;
  }) =>
    Effect.gen(function* () {
      // The checks revalidator may have just confirmed every run of this head as current.
      const known = yield* KnownWorkflowRuns;
      if (known !== null && known.headSha === input.headSha) {
        return known.runs.flatMap((run) =>
          // A run waiting on a maintainer reports `completed` with an `action_required`
          // conclusion; the `status=action_required` query matches either.
          (run.conclusion === "action_required" || run.status === "action_required") &&
          run.head_branch === input.headBranch
            ? [
                {
                  id: run.id,
                  name: run.name?.trim() || `Workflow run ${run.id}`,
                  url: run.html_url?.trim() || null,
                },
              ]
            : [],
        );
      }
      const { owner, name } = parseRepositorySelector(input.repository);
      const runs: GitHubWorkflowRunApproval[] = [];
      for (let page = 1; runs.length <= workflowApprovalLimit; page++) {
        const read: GitHubWorkflowRunPage = yield* restRead({
          cwd: input.cwd,
          host: input.host,
          operation: "listWorkflowRunsRequiringApproval",
          path: `repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&branch=${encodeURIComponent(input.headBranch)}&event=pull_request&status=action_required&per_page=100&page=${page}`,
          decode: decodeWorkflowRunsJson,
        }).pipe(Effect.mapError((error) => workflowApprovalReadError(input.cwd, error)));
        runs.push(...read.runs);
        if (read.rawCount < 100) break;
      }
      return runs;
    });

  const listWorkflowRunsRequiringApproval: GitHubPullRequestCli["Service"]["listWorkflowRunsRequiringApproval"] =
    (input) =>
      Effect.all(
        [
          listHeadsByBranch(input).pipe(
            Effect.flatMap(
              (
                heads,
              ): Effect.Effect<
                GitHubPullRequestHead,
                GitHubPullRequestReadError | GitHubWorkflowApprovalRefusedError
              > => {
                const exactHeads = heads.filter(
                  (pullRequest) =>
                    pullRequest.headSha === input.headSha &&
                    pullRequest.isCrossRepository === true &&
                    pullRequest.headRepositoryOwner?.toLowerCase() ===
                      input.headRepositoryOwner.toLowerCase(),
                );
                if (heads.length > workflowApprovalLimit) {
                  return Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
                      command: "gh",
                      cwd: input.cwd,
                      number: input.number,
                      reason: "head-list-truncated",
                      observedCount: heads.length,
                      limit: workflowApprovalLimit,
                    }),
                  );
                }
                if (exactHeads.length !== 1 || exactHeads[0]?.number !== input.number) {
                  return Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
                      command: "gh",
                      cwd: input.cwd,
                      number: input.number,
                      reason: "head-not-unique",
                      observedCount: exactHeads.length,
                      limit: workflowApprovalLimit,
                    }),
                  );
                }
                return Effect.succeed(exactHeads[0]);
              },
            ),
          ),
          listActionRequiredRuns(input).pipe(
            Effect.flatMap((runs) =>
              runs.length > workflowApprovalLimit
                ? Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
                      command: "gh",
                      cwd: input.cwd,
                      number: input.number,
                      reason: "run-list-truncated",
                      observedCount: runs.length,
                      limit: workflowApprovalLimit,
                    }),
                  )
                : Effect.succeed(runs),
            ),
          ),
        ],
        { concurrency: 2 },
      ).pipe(Effect.map(([, runs]) => runs));

  /** One pull request's summary, through the same aliased query the batch uses. */
  const viewPullRequestSummary = (input: PullRequestSummaryRead) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getPullRequestSummary",
      variables: { owner, name, number: input.number },
      query: pullRequestSummaryGraphQlQuery(input.host === "github.com"),
      decode: decodePullRequestSummariesJson,
    }).pipe(
      Effect.flatMap((summaries) => {
        const summary = summaries.get(0);
        return summary === undefined
          ? Effect.fail(
              readError(
                input.cwd,
                "getPullRequestSummary",
                new Error(`GitHub answered nothing for ${input.repository}#${input.number}.`),
              ),
            )
          : Effect.succeed(summary);
      }),
    );
  };

  /**
   * Summaries asked for together, on one host under one credential, share aliased GraphQL reads
   * of fifty: the background sync reads every linked pull request each minute, and one
   * `gh pr view` apiece is most of what it spends. Whatever the batch cannot answer — a selector
   * GraphQL cannot address, a pull request GitHub returned nothing for — is read on its own.
   */
  const summaryResolver = RequestResolver.makeGrouped<PullRequestSummaryRead, string>({
    key: ({ request, context }) =>
      JSON.stringify([
        request.host.toLowerCase(),
        Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
          ?.credentialFingerprint ?? null,
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ]),
    resolver: (entries) => {
      const [first] = entries;
      const batchable = entries.filter(
        (entry) => buildPullRequestSummariesGraphQlQuery([entry.request]) !== null,
      );
      // Stack membership rides along where GitHub serves stacks, so the background sync can skip
      // the REST stack read for pull requests that are in none.
      const query = buildPullRequestSummariesGraphQlQuery(
        batchable.map((entry) => entry.request),
        first.request.host === "github.com",
      );
      const batched =
        query === null
          ? Effect.succeed(new Map<number, GitHubPullRequestSummary>())
          : graphqlRead({
              cwd: first.request.cwd,
              host: first.request.host,
              operation: "getPullRequestSummary",
              query,
              decode: decodePullRequestSummariesJson,
            });
      return batched.pipe(
        // A GraphQL error anywhere fails the whole document — one repository gone or out of
        // reach — so a batch that could not be read leaves every entry to its own read. A paused
        // budget is the exception: reading one at a time would only spend what is being saved.
        Effect.catchCauseIf(
          (cause) =>
            !Cause.hasInterruptsOnly(cause) &&
            !Cause.findErrorOption(cause).pipe(
              Option.exists((error) => error._tag === "SourceControlRateLimitPausedError"),
            ),
          (cause) =>
            Effect.logDebug("batched pull request summary read failed", { cause }).pipe(
              Effect.as(new Map<number, GitHubPullRequestSummary>()),
            ),
        ),
        Effect.flatMap((summaries) => {
          const unanswered = entries.filter((entry) => {
            const summary = summaries.get(batchable.indexOf(entry));
            if (summary === undefined) return true;
            entry.completeUnsafe(Exit.succeed(summary));
            return false;
          });
          return Effect.forEach(
            unanswered,
            (entry) =>
              viewPullRequestSummary(entry.request).pipe(
                Effect.exit,
                Effect.map((exit) => entry.completeUnsafe(exit)),
              ),
            { concurrency: STAT_REQUEST_CONCURRENCY, discard: true },
          );
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(SUMMARY_ALIASES_PER_REQUEST),
  );
  const getPullRequestSummary: GitHubPullRequestCli["Service"]["getPullRequestSummary"] = (input) =>
    Effect.request(new PullRequestSummaryRead(input), summaryResolver);

  // Every watched pull request on a host in one read per pass. A pull request the batch has no
  // answer for gets null, and its watch reads it in full; a failed batch fails every entry.
  const watchFingerprintResolver = RequestResolver.makeGrouped<
    PullRequestWatchFingerprintRead,
    string
  >({
    key: ({ request, context }) =>
      JSON.stringify([
        request.host.toLowerCase(),
        Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
          ?.credentialFingerprint ?? null,
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ]),
    resolver: (entries) => {
      const [first] = entries;
      const batchable = entries.filter(
        (entry) => buildPullRequestWatchFingerprintsGraphQlQuery([entry.request]) !== null,
      );
      const query = buildPullRequestWatchFingerprintsGraphQlQuery(
        batchable.map((entry) => entry.request),
      );
      const read =
        query === null
          ? Effect.succeed(new Map<number, GitHubPullRequestWatchFingerprint>())
          : graphqlRead({
              cwd: first.request.cwd,
              host: first.request.host,
              operation: "getPullRequestWatchFingerprint",
              query,
              decode: decodePullRequestWatchFingerprintsJson,
            });
      return read.pipe(
        Effect.map((fingerprints) => {
          for (const entry of entries) {
            const index = batchable.indexOf(entry);
            entry.completeUnsafe(
              Exit.succeed(index === -1 ? null : (fingerprints.get(index) ?? null)),
            );
          }
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(STAT_ALIASES_PER_REQUEST),
  );
  const getPullRequestWatchFingerprint: GitHubPullRequestCli["Service"]["getPullRequestWatchFingerprint"] =
    (input) => Effect.request(new PullRequestWatchFingerprintRead(input), watchFingerprintResolver);

  return GitHubPullRequestCli.of({
    withVerifiedCredential,
    revalidateChecks,
    getRoutingIdentity,
    getViewerLogin: (input) =>
      getRoutingIdentity(input).pipe(Effect.map((identity) => identity.viewer)),

    listPullRequests: (input) => {
      const fallbackMaxRows = Math.max(input.limit + 1, PULL_REQUEST_FALLBACK_MAX_ROWS);
      const { owner, name } = parseRepositorySelector(input.repository);
      const query = searchQuery({ ...input, repositories: [input.repository] });
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            command: "gh",
            cwd: input.cwd,
            operation: "listPullRequests",
          }),
        );
      }
      /** Pages of up to a hundred until `rows` have arrived or GitHub has no more. */
      const collect = (
        rows: number,
        page: (
          after: string | null,
          rows: number,
        ) => Effect.Effect<GitHubPullRequestListPage, GitHubPullRequestCliError>,
      ) =>
        Effect.gen(function* () {
          const items: GitHubPullRequestListItem[] = [];
          let rawCount = 0;
          let after: string | null = null;
          do {
            const read: GitHubPullRequestListPage = yield* page(after, rows - rawCount);
            items.push(...read.items);
            rawCount += read.rawCount;
            after = read.endCursor;
          } while (after !== null && rawCount < rows);
          return { items, rawCount };
        });
      const read = (
        continues: boolean,
        requestedRows = input.limit + 1,
      ): Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestCliError> =>
        collect(requestedRows, (after, rows) =>
          continues
            ? graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listPullRequests",
                // The reader's own words are in the query.
                variables: { q: query, after },
                query: pullRequestSearchGraphQlQuery(rows, false, true),
                decode: decodePullRequestSearchJson,
              })
            : graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listPullRequests",
                variables: { owner, name, states: LIST_STATES[input.state], after },
                query: pullRequestListGraphQlQuery(rows),
                decode: decodePullRequestListJson,
              }),
        ).pipe(
          Effect.flatMap(({ items: rawItems, rawCount }) => {
            const items = continues
              ? rawItems
              : rawItems.filter((item) => matchesUnsortedListing(item, input));
            if (
              !continues &&
              items.length < input.limit &&
              rawCount >= requestedRows &&
              requestedRows < fallbackMaxRows
            ) {
              const nextRows = Math.min(requestedRows * 2, fallbackMaxRows);
              if (nextRows > requestedRows) return read(false, nextRows);
            }
            return Effect.succeed({
              items: items.slice(0, input.limit),
              // One row over the page size is the probe for a next page, and it is
              // counted before decoding: a skipped malformed row must not end paging.
              truncated: continues
                ? rawCount > input.limit
                : items.length > input.limit || rawCount >= requestedRows,
              continues,
            });
          }),
        );
      // GitHub does not index every repository for search, and one it will not search answers
      // with no rows rather than with an error — so an empty listing is read again from the
      // repository's own list. Those rows come back newest-created first, an order no `updated:`
      // qualifier can carry on from, so that page says it cannot be continued and the reader
      // reaches the rest of it by asking for a larger page, as every listing used to.
      //
      // Only ever the first slice: a repository that answered the search once will answer it
      // again, so an empty slice under a cursor is a repository that has run out.
      // A text search that finds nothing has found nothing: falling back would answer it with the
      // repository's whole list, which is every row the reader did not search for. The fallback
      // is for a repository the index does not cover, and a listing with no text to match is the
      // only place an empty answer can mean that.
      // Every filter is a qualifier `matchesFilters` can judge over the fallback's own rows just
      // as well as search judges them over its own, so carrying them into the fallback answers
      // the same read rather than a wider one. Free text is the one thing the fallback cannot
      // judge locally — it lists rows, it does not search their text — so a query still rules
      // the fallback out: an empty answer under one is already the answer.
      const hasQuery = (input.query?.trim().length ?? 0) > 0;
      return read(true).pipe(
        Effect.filterOrElse(
          (batch) => batch.items.length > 0 || input.cursor !== undefined || hasQuery,
          () => read(false),
        ),
        Effect.flatMap((batch) => {
          // Match the search query's host support, and enrich only rows that survived paging.
          if (input.host !== "github.com" || batch.items.length === 0) return Effect.succeed(batch);
          const chunks: Array<ReadonlyArray<GitHubPullRequestListItem>> = [];
          for (let start = 0; start < batch.items.length; start += STAT_ALIASES_PER_REQUEST) {
            chunks.push(batch.items.slice(start, start + STAT_ALIASES_PER_REQUEST));
          }
          return Effect.forEach(
            chunks,
            (chunk) => {
              const query = buildPullRequestStackMembershipsGraphQlQuery(
                input.repository,
                chunk.map((item) => item.number),
              );
              if (query === null) return Effect.succeed(chunk);
              return graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listPullRequestStackMemberships",
                query,
                decode: decodePullRequestStackMembershipsJson,
              }).pipe(
                Effect.map((memberships) =>
                  chunk.map((item, index) => {
                    const stack = memberships.get(index);
                    return stack === undefined ? item : { ...item, stack };
                  }),
                ),
                // Optional badges must not take down a listing that already read successfully.
                Effect.catch(() =>
                  Effect.logWarning("Pull request stack membership enrichment failed", {
                    operation: "listPullRequestStackMemberships",
                    host: input.host,
                    rows: chunk.length,
                  }).pipe(Effect.as(chunk)),
                ),
              );
            },
            { concurrency: STAT_REQUEST_CONCURRENCY },
          ).pipe(Effect.map((chunks) => ({ ...batch, items: chunks.flat() })));
        }),
      );
    },

    searchPullRequests: (input) => {
      const query = searchQuery(input);
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            command: "gh",
            cwd: input.cwd,
            operation: "searchPullRequests",
          }),
        );
      }
      // One extra row reveals that the host has more than the slice shows, the way the
      // per-repository read does — up to GitHub's own ceiling on a search page, past which
      // `hasNextPage` is what says there is more.
      const rows = Math.min(input.limit + 1, PULL_REQUEST_SEARCH_MAX_ROWS);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "searchPullRequests",
        variables: { q: query, after: null },
        query: pullRequestSearchGraphQlQuery(rows, input.host === "github.com"),
        decode: decodePullRequestSearchJson,
      }).pipe(
        Effect.map((batch) => ({
          items: batch.items.slice(0, input.limit),
          truncated: batch.rawCount > input.limit || batch.hasNextPage,
        })),
      );
    },

    listPullRequestStats: (input) => {
      const chunks: Array<ReadonlyArray<{ readonly repository: string; readonly number: number }>> =
        [];
      for (let start = 0; start < input.changeRequests.length; start += STAT_ALIASES_PER_REQUEST) {
        chunks.push(input.changeRequests.slice(start, start + STAT_ALIASES_PER_REQUEST));
      }
      return Effect.forEach(
        chunks,
        (chunk) => {
          const query = buildPullRequestStatsGraphQlQuery(chunk);
          if (query === null) {
            return Effect.fail(
              new GitHubRepositorySelectorError({
                command: "gh",
                cwd: input.cwd,
                operation: "listPullRequestStats",
              }),
            );
          }
          return graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listPullRequestStats",
            query,
            decode: decodePullRequestStatsJson,
          }).pipe(
            Effect.map((stats) =>
              chunk.flatMap((changeRequest, index) => {
                const stat = stats.get(index);
                return stat === undefined ? [] : [{ ...changeRequest, ...stat }];
              }),
            ),
          );
        },
        { concurrency: STAT_REQUEST_CONCURRENCY },
      ).pipe(Effect.map((results) => results.flat()));
    },

    getPullRequestSummary,
    getPullRequestWatchFingerprint,

    getPullRequestDetail,
    getPullRequestPreview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getPullRequestPreview",
        variables: { owner, name, number: input.number },
        query: PULL_REQUEST_PREVIEW_GRAPHQL_QUERY,
        decode: decodePullRequestPreviewJson,
      });
    },
    listWorkflowRunsRequiringApproval,

    getPullRequestStack: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return restRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getPullRequestStack",
        path: `repos/${owner}/${name}/stacks?pull_request=${input.number}`,
        decode: decodePullRequestStacksJson,
      }).pipe(
        // @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off - the fallback needs a non-null stack, which a predicate that also reads includeDetails cannot refine.
        Effect.flatMap((stack) => {
          if (!input.includeDetails || stack === null) return Effect.succeed(stack);
          return restRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getPullRequestStack",
            path: `repos/${owner}/${name}/stacks/${stack.number}`,
            decode: (raw) => decodePullRequestStacksJson(`[${raw}]`),
          });
        }),
        // Hosts without the stacks preview return 404. Other failures must preserve the
        // previously synced stack and let the caller retry.
        Effect.catchTags({
          GitHubApiNotFoundError: () => Effect.succeed(null),
        }),
      );
    },

    getPullRequestActivity: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        let author: PullRequestActor | null = null;
        let commits: ReadonlyArray<PullRequestCommit> = [];
        const remarks: PullRequestComment[] = [];
        let commentsAfter: string | null = null;
        let reviewsAfter: string | null = null;
        let withComments = true;
        let withReviews = true;
        // Both remark lists page on their own; a page asks only for the ones with more to give.
        for (let page = 0; page < REVIEW_THREAD_PAGES && (withComments || withReviews); page++) {
          const read: GitHubPullRequestActivityPage = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getPullRequestActivity",
            variables: {
              owner,
              name,
              number: input.number,
              head: page === 0,
              withComments,
              commentsAfter,
              withReviews,
              reviewsAfter,
            },
            query: PULL_REQUEST_ACTIVITY_GRAPHQL_QUERY,
            decode: decodePullRequestActivityJson,
          });
          if (page === 0) {
            author = read.author ?? null;
            commits = read.commits ?? [];
          }
          remarks.push(...read.remarks);
          commentsAfter = read.nextCommentsCursor;
          reviewsAfter = read.nextReviewsCursor;
          withComments = withComments && commentsAfter !== null;
          withReviews = withReviews && reviewsAfter !== null;
        }
        return {
          author,
          comments: remarks.toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          ),
          commits,
        } satisfies GitHubPullRequestActivity;
      }),

    getPullRequestDiff: (input) => {
      const filesPage = (page: number) =>
        diffFilesPage({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          page,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        });
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return Effect.fail(new GitHubDiffCommitError({ command: "gh", cwd: input.cwd }));
      }
      // A cursor only ever comes from the files walk, so a reader carrying one is already past
      // the point where `gh pr diff` had anything to say.
      if (input.cursor !== undefined) {
        const page = diffCursorPage(input.cursor);
        return page === null
          ? Effect.fail(new GitHubDiffCursorError({ command: "gh", cwd: input.cwd }))
          : filesPage(page);
      }
      // `gh pr diff` speaks for the whole pull request and has no way to name one commit of it.
      if (input.commit !== undefined) {
        return filesPage(1);
      }
      const { owner, name } = parseRepositorySelector(input.repository);
      return api
        .rest({
          host: input.host,
          operation: "getPullRequestDiff",
          path: `repos/${owner}/${name}/pulls/${input.number}`,
          accept: "application/vnd.github.diff",
          maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
          timeout: DIFF_TIMEOUT,
        })
        .pipe(
          Effect.flatMap((response) =>
            // A patch cut at a byte boundary ends mid-file, which is neither a whole slice nor
            // something the reader can carry on from. The files API can serve the same change a
            // whole number of files at a time, so an oversized patch takes that road as well.
            response.truncated
              ? filesPage(1)
              : // One read served the whole patch, so there is no next slice to ask for.
                Effect.succeed({ patch: response.body, truncated: false, nextCursor: null }),
          ),
          // GitHub answers 406 rather than a diff past 300 changed files, so the patch is read
          // from the files API instead, a page per call. Only once the direct read has failed: a
          // pull request GitHub will serve a diff for must not pay for a second request. A
          // fallback that fails too reports the original refusal, which is the one that explains
          // the page. Narrowed to a request GitHub answered and refused: a missing credential or
          // a rate limit fails the same way for every request.
          Effect.catchTags({
            GitHubApiResponseError: (error) => filesPage(1).pipe(Effect.mapError(() => error)),
          }),
        );
    },

    getPullRequestDiffFileContents,

    getReviewThreadComments: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getReviewThreadComments",
        variables: {
          owner,
          name,
          number: input.number,
          threadId: input.threadId,
          cursor: input.cursor,
        },
        query: REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY,
        decode: decodeReviewThreadCommentsJson,
      }).pipe(
        Effect.flatMap(({ belongsToPullRequest, comments, nextCursor }) =>
          belongsToPullRequest
            ? Effect.succeed({ comments, nextCursor })
            : Effect.fail(
                new GitHubSubjectScopeError({
                  command: "gh",
                  cwd: input.cwd,
                  operation: "getReviewThreadComments",
                }),
              ),
        ),
      );
    },

    listReviewThreadComments: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        const threadPage = (
          cursor: string | null,
        ): Effect.Effect<GitHubReviewThreadPage, GitHubPullRequestCliError> =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listReviewThreadComments",
            variables: { owner, name, number: input.number, cursor },
            query: REVIEW_THREADS_GRAPHQL_QUERY,
            decode: decodeReviewThreadsJson,
          });
        const entries: GitHubReviewThreadEntry[] = [];
        const avatarsByLogin = new Map<string, string>();
        const botLogins = new Set<string>();
        const commitStats = new Map<
          string,
          { readonly additions: number; readonly deletions: number }
        >();
        let reviewers: ReadonlyArray<PullRequestActor> = [];
        let reactions: GitHubReviewThreadPage["reactions"] = [];
        const reactionsById = new Map<string, ReadonlyArray<PullRequestReaction>>();
        const editedAtById = new Map<string, string>();
        let commits: GitHubReviewThreadPage["commits"] = [];
        let viewer: GitHubReviewThreadPage["viewer"] = { canUpdate: true, didAuthor: false };
        const dismissalsByReviewId = new Map<string, string>();
        let dismissalCursor: string | null = null;
        let cursor: string | null = null;
        let page = 0;
        do {
          const read: GitHubReviewThreadPage = yield* threadPage(cursor);
          entries.push(...read.threads);
          for (const login of read.botLogins) botLogins.add(login);
          for (const [login, avatarUrl] of read.avatarsByLogin)
            avatarsByLogin.set(login, avatarUrl);
          // The roster, the commits and the viewer's standing travel with every page, and the
          // first one already carries all of them.
          if (page === 0) {
            reviewers = read.reviewers;
            reactions = read.reactions;
            for (const [id, entry] of read.reactionsById) reactionsById.set(id, entry);
            for (const [id, editedAt] of read.editedAtById) editedAtById.set(id, editedAt);
            commits = read.commits;
            viewer = read.viewer;
            for (const [id, message] of read.dismissalsByReviewId)
              dismissalsByReviewId.set(id, message);
            dismissalCursor = read.nextDismissalCursor;
            for (const [oid, stat] of read.commitStats) commitStats.set(oid, stat);
          }
          cursor = read.nextCursor;
          page += 1;
        } while (cursor !== null && page < REVIEW_THREAD_PAGES);

        // Almost never entered: the embedded page already holds every dismissal a pull request
        // ordinarily accrues. Followed so a review whose event fell past that page still finds
        // its reason.
        let dismissalPage = 0;
        while (dismissalCursor !== null && dismissalPage < REVIEW_THREAD_PAGES) {
          const read: {
            readonly dismissalsByReviewId: ReadonlyMap<string, string>;
            readonly nextCursor: string | null;
          } = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listReviewThreadComments",
            variables: { owner, name, number: input.number, cursor: dismissalCursor },
            query: REVIEW_DISMISSALS_GRAPHQL_QUERY,
            decode: decodeReviewDismissalsJson,
          });
          for (const [id, message] of read.dismissalsByReviewId)
            dismissalsByReviewId.set(id, message);
          dismissalCursor = read.nextCursor;
          dismissalPage += 1;
        }

        const reviewThreads = entries.map((entry) => ({
          ...entry.thread,
          commentCount: entry.commentCount,
          ...(entry.nextCommentCursor === null
            ? {}
            : { nextCommentsCursor: entry.nextCommentCursor }),
        }));
        return {
          comments: reviewThreadConversation(reviewThreads),
          dismissalsByReviewId,
          reviewThreads,
          // GitHub's own count of each thread, so the number the page shows is the host's even
          // where a bound kept some of the words on GitHub.
          commentCount: entries.reduce((total, entry) => total + entry.commentCount, 0),
          truncated: cursor !== null || entries.some((entry) => entry.nextCommentCursor !== null),
          reviewThreadsTruncated: cursor !== null,
          reactions,
          reactionsById,
          editedAtById,
          reviewers,
          avatarsByLogin,
          botLogins,
          commitStats,
          commits,
          viewer,
        };
      }),

    listActorAvatars: (input) => {
      if (input.ids.length === 0) {
        return Effect.succeed(new Map<string, string>());
      }
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listActorAvatars",
        variables: { ids: input.ids },
        query: ACTOR_AVATARS_GRAPHQL_QUERY,
        decode: decodeActorAvatarsJson,
      });
    },

    getViewerAccess: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getViewerAccess",
        ...(input.allowReserve === true ? { allowReserve: true } : {}),
        variables: { owner, name, number: input.number },
        query: VIEWER_PERMISSIONS_GRAPHQL_QUERY,
        decode: decodeViewerPermissionsJson,
      });
    },

    listReviewerCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listReviewerCandidates",
        allowReserve: true,
        variables: { owner, name, number: input.number },
        query: REVIEWER_CANDIDATES_GRAPHQL_QUERY,
        decode: decodeReviewerCandidatesJson,
      });
    },

    setReviewerRequest: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      // Posting to a login GitHub has already been asked about is what a re-request is, so
      // there is nothing to say here about somebody who has reviewed once already.
      return api
        .rest({
          host: input.host,
          operation: "setReviewerRequest",
          method: input.requested ? "POST" : "DELETE",
          path: `repos/${owner}/${name}/pulls/${input.number}/requested_reviewers`,
          body: buildReviewerRequest(input.reviewers),
        })
        .pipe(Effect.asVoid);
    },

    listLabelCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listLabelCandidates",
        allowReserve: true,
        variables: { owner, name, number: input.number },
        query: LABEL_CANDIDATES_GRAPHQL_QUERY,
        decode: decodeLabelCandidatesJson,
      });
    },

    setLabels: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      // A pull request is an issue to the labels API. Adding posts a list and leaves what was
      // already there; taking off is one delete per label, since the endpoint names one in its
      // path. The name goes into the path encoded, because a label may carry a space or a slash.
      const issue = `repos/${owner}/${name}/issues/${input.number}/labels`;
      if (input.applied) {
        return api
          .rest({
            host: input.host,
            operation: "setLabels",
            method: "POST",
            path: issue,
            body: buildLabelRequest(input.labels),
          })
          .pipe(Effect.asVoid);
      }
      return Effect.forEach(
        input.labels,
        (label) =>
          api.rest({
            host: input.host,
            operation: "setLabels",
            method: "DELETE",
            path: `${issue}/${encodeURIComponent(label)}`,
          }),
        { concurrency: 1, discard: true },
      );
    },

    runPullRequestAction: (input) => {
      if (input.stackNumber !== undefined)
        return runGitHubStackAction({ ...input, stackNumber: input.stackNumber }).pipe(
          Effect.provideService(GitHubApi.GitHubApi, api),
          Effect.provideService(VcsProcess.VcsProcess, vcsProcess),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      if (input.action === "revert") {
        return pullRequestNodeId({ ...input, operation: "revertPullRequest" }).pipe(
          Effect.flatMap((pullRequestId) =>
            graphql({
              host: input.host,
              operation: "revertPullRequest",
              query: REVERT_PULL_REQUEST_GRAPHQL_MUTATION,
              variables: { pullRequestId },
            }),
          ),
        );
      }
      if (input.action === "approve-workflows") {
        const { owner, name } = parseRepositorySelector(input.repository);
        return getPullRequestDetail(input).pipe(
          Effect.flatMap((detail) => {
            if (detail.isCrossRepository !== true) return Effect.void;
            if (detail.headSha == null || detail.headRepositoryOwner == null) {
              return Effect.fail(
                new GitHubWorkflowApprovalHeadUnavailableError({
                  command: "gh",
                  cwd: input.cwd,
                  number: input.number,
                }),
              );
            }
            const expectedHeadSha = detail.headSha;
            const expectedHeadBranch = detail.headBranch;
            const expectedHeadRepositoryOwner = detail.headRepositoryOwner;
            return listWorkflowRunsRequiringApproval({
              ...input,
              headSha: expectedHeadSha,
              headBranch: expectedHeadBranch,
              headRepositoryOwner: expectedHeadRepositoryOwner,
              isCrossRepository: true,
            }).pipe(
              Effect.flatMap((runs) =>
                Effect.forEach(
                  runs,
                  (run) =>
                    getPullRequestDetail(input).pipe(
                      Effect.flatMap((current) => {
                        if (current.headSha == null || current.headRepositoryOwner == null) {
                          return Effect.fail(
                            new GitHubWorkflowApprovalHeadUnavailableError({
                              command: "gh",
                              cwd: input.cwd,
                              number: input.number,
                            }),
                          );
                        }
                        if (
                          current.isCrossRepository !== true ||
                          current.headSha !== expectedHeadSha ||
                          current.headBranch !== expectedHeadBranch ||
                          current.headRepositoryOwner.toLowerCase() !==
                            expectedHeadRepositoryOwner.toLowerCase()
                        ) {
                          return Effect.fail(
                            new GitHubWorkflowApprovalHeadChangedError({
                              command: "gh",
                              cwd: input.cwd,
                              number: input.number,
                            }),
                          );
                        }
                        return listWorkflowRunsRequiringApproval({
                          ...input,
                          headSha: current.headSha,
                          headBranch: current.headBranch,
                          headRepositoryOwner: current.headRepositoryOwner,
                          isCrossRepository: true,
                        });
                      }),
                      Effect.flatMap((currentRuns) =>
                        currentRuns.some((current) => current.id === run.id)
                          ? api
                              .rest({
                                host: input.host,
                                operation: "approveWorkflowRun",
                                method: "POST",
                                path: `repos/${owner}/${name}/actions/runs/${run.id}/approve`,
                              })
                              .pipe(Effect.asVoid)
                          : Effect.void,
                      ),
                    ),
                  { concurrency: 1, discard: true },
                ),
              ),
            );
          }),
        );
      }
      const action = input.action;
      if (action in SIMPLE_ACTION_MUTATIONS) {
        return pullRequestNodeId({ ...input, operation: "runPullRequestAction" }).pipe(
          Effect.flatMap((pullRequestId) =>
            graphql({
              host: input.host,
              operation: "runPullRequestAction",
              query: SIMPLE_ACTION_MUTATIONS[action as keyof typeof SIMPLE_ACTION_MUTATIONS],
              variables: { pullRequestId },
            }),
          ),
        );
      }
      return Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        // Read fresh rather than from the node id cache: merging and updating act on the head
        // as it stands now, and the merge queue decides which mutation a merge is.
        const state = yield* graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "runPullRequestAction",
          allowReserve: true,
          query: ACTION_STATE_GRAPHQL_QUERY,
          variables: {
            owner,
            name,
            number: input.number,
            headRef: `refs/pull/${input.number}/head`,
          },
          decode: decodeActionState,
        });
        if (action === "update-branch") {
          // Already current is done, the way `gh pr update-branch` reports it.
          if (state.baseRef?.compare?.behindBy === 0) return;
          // GitHub updates with a merge commit unless asked to rebase, which is its own default.
          return yield* graphql({
            host: input.host,
            operation: "runPullRequestAction",
            query: UPDATE_BRANCH_GRAPHQL_MUTATION,
            variables: {
              pullRequestId: state.id,
              expectedHeadOid: state.headRefOid,
              updateMethod: input.updateMethod === "rebase" ? "REBASE" : "MERGE",
            },
          });
        }
        let body: string | undefined;
        let expectedHead: string | undefined;
        if (input.removeAgentCreditsOnMerge === true && input.mergeMethod !== "rebase") {
          const message = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "runPullRequestAction",
            allowReserve: true,
            query: MERGE_MESSAGE_GRAPHQL_QUERY,
            variables: {
              owner,
              name,
              number: input.number,
              method: input.mergeMethod === "squash" ? "SQUASH" : "MERGE",
            },
            decode: decodeMergeMessage,
          });
          // GitHub's merge queue chooses its own message and ignores custom text.
          if (!message.isMergeQueueEnabled) {
            const cleaned = removeAgentCredits(message.viewerMergeBodyText);
            if (cleaned !== message.viewerMergeBodyText) {
              body = cleaned;
              expectedHead = message.headRefOid;
            }
          }
        }
        // A merge queue takes a pull request through auto-merge rather than a direct merge, and
        // `--auto` on a pull request that is mergeable right now simply merges it, as `gh` does.
        // GitHub stores the strategy with a standing instruction rather than choosing one at
        // merge time, so arming still names it.
        const auto =
          state.isMergeQueueEnabled === true ||
          (action === "enable-auto-merge" &&
            !IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? ""));
        yield* graphql({
          host: input.host,
          operation: "runPullRequestAction",
          query: auto ? ENABLE_AUTO_MERGE_GRAPHQL_MUTATION : MERGE_PULL_REQUEST_GRAPHQL_MUTATION,
          variables: {
            input: {
              pullRequestId: state.id,
              mergeMethod: GRAPHQL_MERGE_METHODS[input.mergeMethod ?? "merge"],
              ...(expectedHead === undefined ? {} : { expectedHeadOid: expectedHead }),
              ...(body === undefined ? {} : { commitBody: body }),
            },
          },
        });
      });
    },

    commentOnPullRequest: (input) =>
      pullRequestNodeId({ ...input, operation: "commentOnPullRequest" }).pipe(
        Effect.flatMap((subjectId) =>
          graphql({
            host: input.host,
            operation: "commentOnPullRequest",
            query: ADD_COMMENT_GRAPHQL_MUTATION,
            variables: { subjectId, body: input.body },
          }),
        ),
      ),

    submitReview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      // The whole review is one request, so nothing is visible to anyone else until the verdict
      // is sent.
      return api
        .rest({
          host: input.host,
          operation: "submitReview",
          method: "POST",
          path: `repos/${owner}/${name}/pulls/${input.number}/reviews`,
          body: buildReviewSubmission({
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          }),
        })
        .pipe(Effect.asVoid);
    },

    replyToReviewThread: (input) =>
      graphql({
        host: input.host,
        operation: "replyToReviewThread",
        query: REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId, body: input.body },
      }),

    getPullRequestFilesViewed: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const read = (
        after: string | null,
        collected: ReadonlyArray<PullRequestFileViewed>,
        pagesLeft: number,
      ): Effect.Effect<GitHubPullRequestFilesViewed, GitHubPullRequestCliError> =>
        graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "getPullRequestFilesViewed",
          variables: { owner, name, number: input.number, after },
          query: PULL_REQUEST_FILES_VIEWED_GRAPHQL_QUERY,
          decode: decodePullRequestFilesViewedJson,
        }).pipe(
          Effect.flatMap((page) => {
            const files = [...collected, ...page.files];
            if (page.nextCursor === null) {
              return Effect.succeed({ files, truncated: false });
            }
            return pagesLeft <= 1
              ? Effect.succeed({ files, truncated: true })
              : read(page.nextCursor, files, pagesLeft - 1);
          }),
        );
      return read(null, [], FILES_VIEWED_MAX_PAGES);
    },

    setPullRequestFilesViewed: (input) => {
      const mutation = buildSetFilesViewedGraphQlMutation(input.files);
      if (mutation === null) return Effect.void;
      return pullRequestNodeId({ ...input, operation: "setPullRequestFilesViewed" }).pipe(
        Effect.flatMap((pullRequestId) =>
          graphql({
            host: input.host,
            operation: "setPullRequestFilesViewed",
            query: mutation.query,
            variables: { pullRequestId, ...mutation.variables },
          }),
        ),
      );
    },

    setReviewThreadResolution: (input) =>
      graphql({
        host: input.host,
        operation: "setReviewThreadResolution",
        query: input.resolved
          ? RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION
          : UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId },
      }),

    setReaction: (input) => {
      const givenSubjectId = input.subjectId;
      const subjectId =
        givenSubjectId === undefined
          ? pullRequestNodeId({ ...input, operation: "setReaction" })
          : subjectBelongsToPullRequest({
              ...input,
              subjectId: givenSubjectId,
              operation: "setReaction",
            }).pipe(
              Effect.flatMap((belongs) =>
                belongs
                  ? Effect.succeed(givenSubjectId)
                  : Effect.fail(
                      new GitHubSubjectScopeError({
                        command: "gh",
                        cwd: input.cwd,
                        operation: "setReaction",
                      }),
                    ),
              ),
            );
      return subjectId.pipe(
        Effect.flatMap((subjectId) =>
          graphql({
            host: input.host,
            operation: "setReaction",
            query: input.reacted ? ADD_REACTION_GRAPHQL_MUTATION : REMOVE_REACTION_GRAPHQL_MUTATION,
            variables: { subjectId, content: gitHubReactionContent(input.content) },
          }),
        ),
      );
    },

    updatePullRequest: (input) =>
      pullRequestNodeId({ ...input, operation: "updatePullRequest" }).pipe(
        Effect.flatMap((pullRequestId) =>
          graphql({
            host: input.host,
            operation: "updatePullRequest",
            query: UPDATE_PULL_REQUEST_GRAPHQL_MUTATION,
            // A field the caller did not name is left out of the request entirely, so GitHub
            // keeps the words that are there rather than being asked for an empty one.
            variables: {
              pullRequestId,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            },
          }),
        ),
      ),

    updateComment: (input) =>
      subjectBelongsToPullRequest({
        cwd: input.cwd,
        repository: input.repository,
        host: input.host,
        number: input.number,
        subjectId: input.commentId,
        operation: "updateComment",
      }).pipe(
        Effect.flatMap((belongs) =>
          belongs
            ? Effect.succeed(input.commentId)
            : Effect.fail(
                new GitHubSubjectScopeError({
                  command: "gh",
                  cwd: input.cwd,
                  operation: "updateComment",
                }),
              ),
        ),
        Effect.flatMap((commentId) =>
          graphql({
            host: input.host,
            operation: "updateComment",
            query:
              input.kind === "issue-comment"
                ? UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION
                : UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION,
            variables: { commentId, body: input.body },
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(GitHubPullRequestCli, make);

import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { KnownWorkflowRuns, makeChecksRevalidator } from "./gitHubConditionalChecks.ts";
import { runGitHubStackAction, type GitHubStackActionError } from "./githubStackActions.ts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { GraphQLClient, GraphQLClientError, GraphQLGroup, GraphQLResolver } from "effect/graphql";
import { HttpClient } from "effect/http";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
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

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { PullRequestBatchesGraphQLGroup } from "./pullRequestBatches.graphql.ts";
import { PullRequestMutationsGraphQLGroup } from "./pullRequestMutations.graphql.ts";
import { PullRequestReadsGraphQLGroup } from "./pullRequestReads.graphql.ts";
import { PullRequestReviewsGraphQLGroup } from "./pullRequestReviews.graphql.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  buildReviewSubmission,
  buildReviewerRequest,
  decodeCommitFilesJson,
  pullRequestChecksFromContexts,
  decodeWorkflowRunsJson,
  type GitHubPullRequestCore,
  type GitHubPullRequestFileStat,
  type GitHubPullRequestWatchFingerprint,
  isSubjectOfPullRequest,
  LenientPullRequestList,
  LenientPullRequestSearch,
  pageRows,
  pullRequestLookup,
  toActorAvatars,
  toLabelCandidates,
  toPullRequestActivityPage,
  toPullRequestCheckContextsPage,
  toPullRequestCore,
  toPullRequestFilesViewedPage,
  toPullRequestFileStatsPage,
  toPullRequestHeads,
  toPullRequestNodeId,
  toPullRequestPreview,
  toPullRequestRows,
  toPullRequestSummary,
  toPullRequestWatchFingerprint,
  toReviewDismissalsPage,
  toReviewerCandidates,
  toReviewThreadCommentsPage,
  toReviewThreadPage,
  toStackMembership,
  toViewerPermissions,
  decodePullRequestFilesJson,
  decodePullRequestStacksJson,
  buildLabelRequest,
  PULL_REQUEST_SEARCH_MAX_ROWS,
  gitHubReactionContent,
  reviewThreadConversation,
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
  IMMEDIATELY_MERGEABLE,
} from "./gitHubPullRequestJson.ts";
import type {
  ProviderChangeRequestSummary,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

export class GitHubPullRequestReadError extends Schema.TaggedError<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub returned an unreadable ${this.operation} response.`;
  }
}

export class GitHubViewerLoginUnavailableError extends Schema.TaggedError<GitHubViewerLoginUnavailableError>()(
  "GitHubViewerLoginUnavailableError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "GitHub returned no login for the authenticated account.";
  }
}

export class GitHubPullRequestUpdatedAtUnavailableError extends Schema.TaggedError<GitHubPullRequestUpdatedAtUnavailableError>()(
  "GitHubPullRequestUpdatedAtUnavailableError",
  {
    cwd: Schema.String,
    repository: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `Pull request ${this.repository}#${this.number} reported no update time.`;
  }
}

export class GitHubDiffCursorError extends Schema.TaggedError<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The diff cursor was not one this pull request handed out.";
  }
}

export class GitHubDiffCommitError extends Schema.TaggedError<GitHubDiffCommitError>()(
  "GitHubDiffCommitError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The named commit was not a commit sha.";
  }
}

export class GitHubDiffRevisionsUnavailableError extends Schema.TaggedError<GitHubDiffRevisionsUnavailableError>()(
  "GitHubDiffRevisionsUnavailableError",
  {
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

export class GitHubDiffFileContentsUnavailableError extends Schema.TaggedError<GitHubDiffFileContentsUnavailableError>()(
  "GitHubDiffFileContentsUnavailableError",
  {
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

export class GitHubRepositorySelectorError extends Schema.TaggedError<GitHubRepositorySelectorError>()(
  "GitHubRepositorySelectorError",
  {
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "A repository was named that GitHub cannot address.";
  }
}

export class GitHubSubjectScopeError extends Schema.TaggedError<GitHubSubjectScopeError>()(
  "GitHubSubjectScopeError",
  {
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "The named subject did not belong to the named pull request.";
  }
}

export class GitHubWorkflowApprovalRefusedError extends Schema.TaggedError<GitHubWorkflowApprovalRefusedError>()(
  "GitHubWorkflowApprovalRefusedError",
  {
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

export class GitHubWorkflowApprovalHeadUnavailableError extends Schema.TaggedError<GitHubWorkflowApprovalHeadUnavailableError>()(
  "GitHubWorkflowApprovalHeadUnavailableError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `GitHub did not report a complete head revision for #${this.number}.`;
  }
}

export class GitHubWorkflowApprovalHeadChangedError extends Schema.TaggedError<GitHubWorkflowApprovalHeadChangedError>()(
  "GitHubWorkflowApprovalHeadChangedError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `The head revision of #${this.number} changed before its workflows could be approved.`;
  }
}

export class GitHubBranchDeletionRefusedError extends Schema.TaggedError<GitHubBranchDeletionRefusedError>()(
  "GitHubBranchDeletionRefusedError",
  {
    number: Schema.Int,
    reason: Schema.Literals([
      "open-pr",
      "stack",
      "source-unavailable",
      "unsafe-branch",
      "head-changed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "open-pr":
        return `Close or merge pull request #${this.number} before deleting its source branch.`;
      case "stack":
        return "Branch deletion is not supported for a stack.";
      case "source-unavailable":
        return `GitHub did not report a complete source branch for pull request #${this.number}.`;
      case "unsafe-branch":
        return "The source branch is a default or base branch and cannot be deleted here.";
      case "head-changed":
        return "The source branch has new commits and was not deleted.";
    }
  }
}

export type GitHubPullRequestApiError =
  | GitHubBranchDeletionRefusedError
  | GitHubStackActionError
  | GitHubRequestPolicy.GitHubApiError
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

const isGraphQlClientError = (error: unknown): error is GraphQLClientError.GraphQLClientError =>
  GraphQLClientError.isGraphQLClientError(error);

const { isNotFoundOnly } = GitHubGraphQlClient;

const isRefusedRequestedReviewersOnly = (error: unknown): boolean =>
  isGraphQlClientError(error) &&
  error.reason._tag === "ResponseError" &&
  error.reason.status === 200 &&
  error.reason.errors.every(
    ({ path, type }) =>
      type === "FORBIDDEN" &&
      path?.length === 6 &&
      path[0] === "repository" &&
      path[1] === "pullRequest" &&
      path[2] === "reviewRequests" &&
      path[3] === "nodes" &&
      typeof path[4] === "number" &&
      Number.isInteger(path[4]) &&
      path[4] >= 0 &&
      path[5] === "requestedReviewer",
  );

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT = Duration.seconds(60);
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

const LIST_STATES: Record<PullRequestListState, ReadonlyArray<"OPEN" | "CLOSED" | "MERGED">> = {
  all: ["OPEN", "CLOSED", "MERGED"],
  open: ["OPEN"],
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
};

interface GitHubPullRequestListPage {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly rawCount: number;
  readonly endCursor: string | null;
}

const PULL_REQUEST_FALLBACK_MAX_ROWS = 1_000;

const DIFF_FILES_PAGE_SIZE = 100;
const FILES_VIEWED_MAX_PAGES = 5;
const FILES_VIEWED_PER_REQUEST = 100;

export const NODE_ID_CACHE_CAPACITY = 128;

const REVIEW_THREAD_PAGES = 10;

const CHECK_CONTEXT_PAGES = 10;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
  /** False for unsearchable pages returned in `gh` order. */
  readonly continues: boolean;
}

export interface GitHubPullRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Four parallel batches of 25 took ~2.1s; one batch of 100 took ~5.2s. */
const STAT_ALIASES_PER_REQUEST = 25;
// Cache checks stagger reads across scheduler ticks; allow time to batch.
const SUMMARY_BATCH_WINDOW = "10 millis";

export interface GitHubPullRequestSearchBatch {
  readonly items: ReadonlyArray<GitHubPullRequestSearchItem>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestDiffSlice {
  readonly patch: string;
  /** Hunks were withheld within this slice. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface GitHubPullRequestFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestFileStats {
  readonly files: ReadonlyArray<GitHubPullRequestFileStat>;
  readonly truncated: boolean;
}

export class GitHubPullRequestApi extends Context.Service<
  GitHubPullRequestApi,
  {
    readonly withVerifiedCredential: <A, E, R>(
      input: { readonly cwd: string; readonly host: string },
      use: (identity: {
        readonly accountId: string;
        readonly viewer: string;
        readonly credentialFingerprint: string;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubPullRequestApiError, R>;
    readonly getRoutingIdentity: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<
      { readonly accountId: string; readonly viewer: string },
      GitHubPullRequestApiError
    >;
    readonly getViewerLogin: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<string, GitHubPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestApiError>;

    readonly searchPullRequests: (input: {
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
    }) => Effect.Effect<GitHubPullRequestSearchBatch, GitHubPullRequestApiError>;

    readonly listPullRequestStats: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestStat>, GitHubPullRequestApiError>;

    readonly getPullRequestSummary: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<ProviderChangeRequestSummary, GitHubPullRequestApiError>;
    /** Null triggers a full watch read when GitHub gives no answer. */
    readonly getPullRequestWatchFingerprint: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestWatchFingerprint | null, GitHubPullRequestApiError>;

    readonly revalidateChecks: Effect.Success<typeof makeChecksRevalidator>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestCore, GitHubPullRequestApiError>;

    readonly getPullRequestPreview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<
      Omit<PullRequestPreview, "projectId" | "repository">,
      GitHubPullRequestApiError
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
    }) => Effect.Effect<ReadonlyArray<GitHubWorkflowRunApproval>, GitHubPullRequestApiError>;

    readonly getPullRequestStack: (input: {
      readonly cwd: string;
      readonly includeDetails?: boolean;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestStack | null, GitHubPullRequestApiError>;

    readonly getPullRequestActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestActivity, GitHubPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestApiError>;

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
      GitHubPullRequestApiError
    >;

    readonly getPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestFilesViewed, GitHubPullRequestApiError>;

    readonly getPullRequestFileStats: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestFileStats, GitHubPullRequestApiError>;

    /**
     * GitHub takes a single path per mutation, so a burst is batched with aliases into one
     * document rather than one subprocess per press.
     */
    readonly setPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestApiError>;

    readonly listActorAvatars: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitHubPullRequestApiError>;

    readonly getReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    }) => Effect.Effect<PullRequestThreadCommentsResult, GitHubPullRequestApiError>;

    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly allowReserve?: boolean | undefined;
    }) => Effect.Effect<GitHubViewerAccess & GitHubRepositoryAccess, GitHubPullRequestApiError>;

    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitHubPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, GitHubPullRequestApiError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

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
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly replyToReviewThread: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly setReviewThreadResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly updatePullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly updateComment: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;
  }
>()("@t3tools/source-control-github/server/GitHubPullRequestApi") {}

function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/** Bound decimal length to prevent exponential notation in request paths. */
function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/** Quote user text so GitHub cannot interpret it as qualifiers that widen the listing. */
function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const REVIEW_QUALIFIERS = {
  approved: "approved",
  "changes-requested": "changes_requested",
  "review-required": "required",
  none: "none",
} as const;

/** Labels/logins cannot contain quotes; strip them to prevent qualifier injection. */
function qualifierValue(value: string): string {
  return `"${value.replaceAll('"', "").trim()}"`;
}

function filterQualifiers(
  filters: PullRequestListFilters | undefined,
  viewer: string,
): ReadonlyArray<string> {
  if (filters === undefined) return [];
  return [
    // Commas within a qualifier mean OR to GitHub.
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

const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Unquoted repo: values must not inject qualifiers. */
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
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed", "is:unmerged"] : []),
    ...(input.state === "merged" ? ["is:merged"] : []),
    ...(input.involvement === "authored" ? [`author:${input.viewer}`] : []),
    ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    ...(input.cursor === undefined ? [] : [`updated:<=${input.cursor.updatedBefore}`]),
    ...filterQualifiers(input.filters, input.viewer),
    "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

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

const GRAPHQL_MERGE_METHODS = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
} as const satisfies Record<PullRequestMergeMethod, string>;

const PullRequestGraphQLGroup = GraphQLGroup.merge(
  PullRequestBatchesGraphQLGroup,
  GraphQLGroup.make(LenientPullRequestSearch, LenientPullRequestList),
  PullRequestReadsGraphQLGroup,
  PullRequestReviewsGraphQLGroup,
  PullRequestMutationsGraphQLGroup,
).middleware(GitHubGraphQlClient.GitHubGraphQlAuth);

interface RestReadInput<A> {
  readonly cwd: string;
  readonly host: string;
  readonly operation: string;
  readonly path: string;
  readonly decode: (raw: string) => Result.Result<A, unknown>;
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const httpClient = yield* HttpClient.HttpClient;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const revalidateChecks = yield* makeChecksRevalidator;
  const client = yield* GraphQLClient.make(PullRequestGraphQLGroup).pipe(
    Effect.provide(GitHubGraphQlClient.layer),
  );
  const routingIdentities = new Map<
    string,
    {
      at: number;
      value: { accountId: string; viewer: string };
    }
  >();
  const identityLocks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();
  const RoutingIdentity = Schema.Struct({
    id: PositiveInt,
    login: TrimmedNonEmptyString,
  });
  const decodeRoutingIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(RoutingIdentity));
  const decodeViewerIdentity = Schema.decodeUnknownEffect(RoutingIdentity);
  const captureVerifiedCredential = Effect.fn("GitHubPullRequestApi.captureVerifiedCredential")(
    function* (input: { readonly cwd: string; readonly host: string }) {
      const unavailable = () => new GitHubViewerLoginUnavailableError({ cwd: input.cwd });
      const host = input.host.toLowerCase();
      const { token, fingerprint: key } = yield* api.credential(host);
      const credential = { host, token, credentialFingerprint: key };
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
              // Pin verification so an auth switch cannot poison its cache entry.
              const identity = yield* api
                .rest({ host, operation: "getRoutingIdentity", path: "user", allowReserve: true })
                .pipe(
                  Effect.flatMap((response) =>
                    decodeRoutingIdentity(response.body).pipe(Effect.mapError(unavailable)),
                  ),
                  Effect.catchTags({
                    GitHubApiResponseError: (error) =>
                      Effect.gen(function* () {
                        if (error.status !== 403) return yield* error;
                        const { viewer } = yield* client.RoutingIdentityViewer({}).pipe(
                          GitHubGraphQlClient.call({
                            host,
                            operation: "getRoutingIdentity",
                            allowReserve: true,
                          }),
                          Effect.catchTags({
                            GraphQLClientError: () => Effect.fail(unavailable()),
                          }),
                        );
                        return yield* decodeViewerIdentity({
                          id: viewer.databaseId,
                          login: viewer.login,
                        }).pipe(Effect.mapError(unavailable));
                      }),
                  }),
                  Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, credential),
                  Effect.provideService(SourceControlRateLimit.CredentialScope, key),
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
  const withVerifiedCredential: GitHubPullRequestApi["Service"]["withVerifiedCredential"] = (
    input,
    use,
  ) =>
    captureVerifiedCredential(input).pipe(
      Effect.flatMap(({ host, token, accountId, viewer, credentialFingerprint }) =>
        use({ accountId, viewer, credentialFingerprint }).pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, credentialFingerprint),
          Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
            host,
            token,
            credentialFingerprint,
          }),
        ),
      ),
    );
  const getRoutingIdentity: GitHubPullRequestApi["Service"]["getRoutingIdentity"] = (input) =>
    captureVerifiedCredential(input).pipe(
      Effect.map(({ accountId, viewer }) => ({ accountId, viewer })),
    );

  const readError = (cwd: string, operation: string, cause: unknown) =>
    new GitHubPullRequestReadError({ cwd, operation, cause });

  const graphql =
    (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly allowReserve?: boolean | undefined;
    }) =>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<
      A,
      | Exclude<E, GraphQLClientError.GraphQLClientError>
      | GitHubRequestPolicy.GitHubApiNotFoundError
      | GitHubRequestPolicy.GitHubApiResponseError
      | GitHubPullRequestReadError,
      Exclude<R, GitHubGraphQlClient.GitHubGraphQlTarget>
    > =>
      effect.pipe(
        GitHubGraphQlClient.call({
          host: input.host,
          operation: input.operation,
          ...(input.allowReserve === true ? { allowReserve: true } : {}),
        }),
        Effect.mapError((error) =>
          isGraphQlClientError(error)
            ? readError(input.cwd, input.operation, error)
            : (error as Exclude<typeof error, GraphQLClientError.GraphQLClientError>),
        ),
      );

  const found =
    (input: { readonly host: string; readonly operation: string }) =>
    <A>(value: A | null): Effect.Effect<A, GitHubRequestPolicy.GitHubApiNotFoundError> =>
      value === null
        ? Effect.fail(
            new GitHubRequestPolicy.GitHubApiNotFoundError({
              host: GitHubRequestPolicy.normalizeHost(input.host),
              operation: input.operation,
            }),
          )
        : Effect.succeed(value);

  /**
   * The pages of a cursor connection, read one after another until GitHub has no more,
   * `maxPages` have been read, or `until` is satisfied. `truncated` says pages remained when
   * reading stopped; a cursor GitHub hands back a second time stops the read as truncated too.
   */
  const readPages = Effect.fn("GitHubPullRequestApi.readPages")(function* <Page, E, R>(
    stream: Stream.Stream<Page, E | GraphQLClientError.GraphQLClientError, R>,
    options: {
      readonly cwd: string;
      readonly operation: string;
      readonly hasNextPage: (page: NoInfer<Page>) => boolean;
      readonly maxPages?: number;
      readonly until?: (pages: ReadonlyArray<NoInfer<Page>>) => boolean;
    },
  ) {
    const pages: Page[] = [];
    let repeated = false;
    yield* stream.pipe(
      // `pages` fails a cursor GitHub hands back unchanged, which would page forever.
      Stream.catch((error) =>
        isGraphQlClientError(error) && error.reason._tag === "PaginationError"
          ? Stream.sync(() => {
              repeated = true;
            }).pipe(Stream.drain)
          : Stream.fail(error),
      ),
      Stream.runForEachWhile((page) =>
        Effect.sync(() => {
          pages.push(page);
          return (
            options.hasNextPage(page) &&
            pages.length < (options.maxPages ?? Infinity) &&
            options.until?.(pages) !== true
          );
        }),
      ),
    );
    const last = pages.at(-1);
    return { pages, truncated: repeated || (last !== undefined && options.hasNextPage(last)) };
  });

  // Immutable PR node IDs can be cached across viewed-file toggles.
  const nodeIds = new Map<string, string>();

  const pullRequestNodeId = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly operation: string;
  }): Effect.Effect<string, GitHubPullRequestApiError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const key = `${input.host} ${owner}/${name} ${input.number}`;
    const held = nodeIds.get(key);
    if (held !== undefined) {
      nodeIds.delete(key);
      nodeIds.set(key, held);
      return Effect.succeed(held);
    }
    return client.PullRequestNodeId({ owner, name, number: input.number }).pipe(
      graphql({ ...input, allowReserve: true }),
      Effect.map(toPullRequestNodeId),
      Effect.flatMap(found(input)),
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

  /** Mutations follow node IDs; reject IDs from other PRs. */
  const subjectBelongsToPullRequest = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly subjectId: string;
    readonly operation: string;
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return client
      .PullRequestSubject({ owner, name, number: input.number, subjectId: input.subjectId })
      .pipe(graphql({ ...input, allowReserve: true }), Effect.map(isSubjectOfPullRequest));
  };

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

  /** A REST read whose JSON answer is decoded the same way. */
  const restRead = <A>(input: RestReadInput<A>): Effect.Effect<A, GitHubPullRequestApiError> =>
    api
      .rest({ host: input.host, operation: input.operation, path: input.path })
      .pipe(
        Effect.flatMap((response) =>
          decodeWith(input.cwd, input.operation, input.decode, response.body),
        ),
      );

  // The last ETag and body of each polled REST read, so an unchanged answer comes back as a
  // 304, which GitHub does not charge. Keyed by the credential the request is pinned to, so a
  // validator never revalidates another account's body. A 304 writes the entry back, so one
  // that is still polled outlives its time to live.
  const validators = yield* Cache.make({
    capacity: 512,
    timeToLive: "1 hour",
    lookup: (_key: string) =>
      Effect.succeed(Option.none<{ readonly etag: string; readonly body: string }>()),
  });
  const revalidatedRestRead = Effect.fn("GitHubPullRequestApi.revalidatedRestRead")(function* <A>(
    input: RestReadInput<A>,
  ) {
    const host = GitHubRequestPolicy.normalizeHost(input.host);
    const { token, fingerprint } = yield* api.credential(host);
    const key = `${fingerprint}\0${host}\0${input.path}`;
    const previous = yield* Cache.get(validators, key);
    const response = yield* api
      .rest({
        host,
        operation: input.operation,
        path: input.path,
        ...(Option.isSome(previous) ? { ifNoneMatch: previous.value.etag } : {}),
      })
      .pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host,
          token,
          credentialFingerprint: fingerprint,
        }),
      );
    if (response.status === 304 && Option.isSome(previous)) {
      yield* Cache.set(validators, key, previous);
      return yield* decodeWith(input.cwd, input.operation, input.decode, previous.value.body);
    }
    const decoded = yield* decodeWith(input.cwd, input.operation, input.decode, response.body);
    const etag = response.headers["etag"]?.trim();
    yield* etag
      ? Cache.set(validators, key, Option.some({ etag, body: response.body }))
      : Cache.invalidate(validators, key);
    return decoded;
  });

  const diffFilesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestApiError> => {
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
          // Byte-truncated responses are unparseable JSON prefixes.
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
          // Use raw row counts so malformed files cannot prematurely end pagination.
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

  const getPullRequestDiffFileContents: GitHubPullRequestApi["Service"]["getPullRequestDiffFileContents"] =
    Effect.fn("GitHubPullRequestApi.getPullRequestDiffFileContents")(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitHubDiffCommitError({ cwd: input.cwd });
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
          input.changeType === "new" ? Effect.succeed("") : readFile(baseRef ?? "", input.oldPath),
          input.changeType === "deleted" ? Effect.succeed("") : readFile(headRef, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    });

  /** Older Enterprise servers may lack `isRequired`. */
  const asksRequired = (host: string) => host.toLowerCase() === "github.com";

  /**
   * Every check context of the head commit, a page at a time, for a rollup the detail read cut at
   * its first hundred. Each page names the head it read, so a push mid-walk fails rather than
   * mixing two revisions' checks.
   */
  const readAllCheckContexts = Effect.fn("GitHubPullRequestApi.readAllCheckContexts")(function* (
    input: Parameters<GitHubPullRequestApi["Service"]["getPullRequestDetail"]>[0],
    allowReserve: boolean,
  ) {
    const { owner, name } = parseRepositorySelector(input.repository);
    const target = { ...input, operation: "getPullRequestDetail", allowReserve };
    let headSha: string | null = null;
    const { pages, truncated } = yield* readPages(
      GraphQLClient.pages(client.PullRequestCheckContexts, {
        variables: { owner, name, number: input.number, required: asksRequired(input.host) },
        connection: (result) => {
          const page = toPullRequestCheckContextsPage(result);
          if (page === null) return null;
          headSha ??= page.headSha;
          return {
            ...page,
            // Past the first page a different head is a push mid-walk.
            changed: page.headSha !== headSha,
            pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor },
          };
        },
      }).pipe(
        Stream.mapEffect((page) =>
          page.changed
            ? Effect.fail(
                readError(
                  input.cwd,
                  "getPullRequestDetail",
                  new Error("Pull request head changed while reading checks."),
                ),
              )
            : Effect.succeed(page),
        ),
      ),
      {
        ...target,
        maxPages: CHECK_CONTEXT_PAGES,
        hasNextPage: (page) => page.nextCursor !== null,
      },
    ).pipe(graphql(target));
    return {
      headSha: pages[0]?.headSha ?? null,
      contexts: pages.flatMap((page) => page.contexts),
      truncated,
    };
  });

  const getPullRequestDetail: GitHubPullRequestApi["Service"]["getPullRequestDetail"] = (input) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const operation = "getPullRequestDetail";
    const read = (requestedReviewers: number) =>
      client.PullRequestCore({
        owner,
        name,
        number: input.number,
        headRef: `refs/pull/${input.number}/head`,
        required: asksRequired(input.host),
        requestedReviewers,
      });
    return SourceControlRateLimit.Interactive.pipe(
      Effect.flatMap((allowReserve) =>
        read(100).pipe(
          Effect.catchIf(isRefusedRequestedReviewersOnly, () => read(0)),
          graphql({ ...input, operation, allowReserve }),
          Effect.map(toPullRequestCore),
          Effect.flatMap(found({ ...input, operation })),
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
                      operation,
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

  const listHeadsByBranch = Effect.fn("GitHubPullRequestApi.listHeadsByBranch")(function* (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly headBranch: string;
  }) {
    const { owner, name } = parseRepositorySelector(input.repository);
    const countHeads = (pages: ReadonlyArray<{ readonly heads: ReadonlyArray<unknown> }>) =>
      pages.reduce((total, page) => total + page.heads.length, 0);
    const target = {
      ...input,
      operation: "listWorkflowRunsRequiringApproval",
      allowReserve: true,
    };
    const { pages, truncated } = yield* readPages(
      GraphQLClient.pages(client.PullRequestHeads, {
        variables: { owner, name, head: input.headBranch },
        connection: (result) => {
          const page = toPullRequestHeads(result);
          return {
            ...page,
            pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor },
          };
        },
      }),
      {
        ...target,
        hasNextPage: (page) => page.nextCursor !== null,
        until: (pages) => countHeads(pages) > workflowApprovalLimit,
      },
    ).pipe(graphql(target));
    return { heads: pages.flatMap((page) => page.heads), truncated };
  });

  const listActionRequiredRuns = Effect.fn("GitHubPullRequestApi.listActionRequiredRuns")(
    function* (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly headSha: string;
      readonly headBranch: string;
    }) {
      const known = yield* KnownWorkflowRuns;
      if (known !== null && known.headSha === input.headSha) {
        return known.runs.flatMap((run) =>
          // Maintainer-gated runs can report completed/action_required.
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
    },
  );

  const listWorkflowRunsRequiringApproval: GitHubPullRequestApi["Service"]["listWorkflowRunsRequiringApproval"] =
    (input) =>
      Effect.all(
        [
          listHeadsByBranch(input).pipe(
            Effect.flatMap(
              ({
                heads,
                truncated,
              }): Effect.Effect<
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
                if (truncated || heads.length > workflowApprovalLimit) {
                  return Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
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

  const simpleActionMutations = {
    "disable-auto-merge": (pullRequestId: string) =>
      client.DisablePullRequestAutoMerge({ pullRequestId }).pipe(Effect.asVoid),
    ready: (pullRequestId: string) =>
      client.MarkPullRequestReadyForReview({ pullRequestId }).pipe(Effect.asVoid),
    draft: (pullRequestId: string) =>
      client.ConvertPullRequestToDraft({ pullRequestId }).pipe(Effect.asVoid),
    close: (pullRequestId: string) =>
      client.ClosePullRequest({ pullRequestId }).pipe(Effect.asVoid),
    reopen: (pullRequestId: string) =>
      client.ReopenPullRequest({ pullRequestId }).pipe(Effect.asVoid),
  } satisfies Partial<Record<PullRequestAction, unknown>>;

  /** Preserve policy errors; map not-found per lookup and other failures to read errors. */
  const batchedRead = <A, E, R>(
    input: { readonly cwd: string; readonly host: string; readonly operation: string },
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    | Exclude<E, GraphQLClientError.GraphQLClientError>
    | GitHubPullRequestReadError
    | GitHubRequestPolicy.GitHubApiNotFoundError,
    Exclude<R, GitHubGraphQlClient.GitHubGraphQlTarget>
  > =>
    effect.pipe(
      Effect.provideService(GitHubGraphQlClient.GitHubGraphQlTarget, {
        host: input.host,
        operation: input.operation,
      }),
      Effect.mapError((error) =>
        !isGraphQlClientError(error)
          ? (error as Exclude<E, GraphQLClientError.GraphQLClientError>)
          : isNotFoundOnly(error)
            ? new GitHubRequestPolicy.GitHubApiNotFoundError({
                host: input.host,
                operation: input.operation,
              })
            : readError(input.cwd, input.operation, error),
      ),
    );

  // Batch by host/credential; isolate missing PRs.
  const summaryResolver = GraphQLResolver.aliased(client.PullRequestSummary, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(STAT_ALIASES_PER_REQUEST),
  );
  const getPullRequestSummary: GitHubPullRequestApi["Service"]["getPullRequestSummary"] = Effect.fn(
    "GitHubPullRequestApi.getPullRequestSummary",
  )(
    function* (input) {
      const lookup = pullRequestLookup(input);
      if (lookup === null) {
        return yield* new GitHubRepositorySelectorError({
          cwd: input.cwd,
          operation: "getPullRequestSummary",
        });
      }
      const result = yield* GraphQLResolver.request(
        { ...lookup, stacks: input.host.toLowerCase() === "github.com" },
        summaryResolver,
      );
      const pullRequest = result.repository?.pullRequest;
      if (pullRequest == null) {
        return yield* new GitHubRequestPolicy.GitHubApiNotFoundError({
          host: input.host,
          operation: "getPullRequestSummary",
        });
      }
      return toPullRequestSummary(pullRequest);
    },
    (effect, input) =>
      effect.pipe((effect) =>
        batchedRead({ ...input, operation: "getPullRequestSummary" }, effect),
      ),
  );

  // A missing fingerprint triggers a full watch read; a failed request fails the whole batch.
  const watchFingerprintResolver = GraphQLResolver.aliased(client.PullRequestWatchFingerprint, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(STAT_ALIASES_PER_REQUEST),
  );
  const getPullRequestWatchFingerprint: GitHubPullRequestApi["Service"]["getPullRequestWatchFingerprint"] =
    (input) => {
      const lookup = pullRequestLookup(input);
      if (lookup === null) return Effect.succeed(null);
      return GraphQLResolver.request(lookup, watchFingerprintResolver).pipe(
        Effect.map((result) => {
          const pullRequest = result.repository?.pullRequest;
          return pullRequest == null ? null : toPullRequestWatchFingerprint(pullRequest);
        }),
        Effect.catchIf(isNotFoundOnly, () => Effect.succeed(null)),
        (effect) => batchedRead({ ...input, operation: "getPullRequestWatchFingerprint" }, effect),
      );
    };

  const statsResolver = GraphQLResolver.aliased(client.PullRequestStats, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(RequestResolver.batchN(STAT_ALIASES_PER_REQUEST));
  const stackMembershipResolver = GraphQLResolver.aliased(client.PullRequestStackMembership, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(RequestResolver.batchN(STAT_ALIASES_PER_REQUEST));
  // GitHub has no bulk viewed-file mutation; aliases combine individual paths into one request.
  const setFileViewedResolver = GraphQLResolver.aliased(client.SetFileViewed, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(RequestResolver.batchN(FILES_VIEWED_PER_REQUEST));

  return GitHubPullRequestApi.of({
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
            cwd: input.cwd,
            operation: "listPullRequests",
          }),
        );
      }
      const target = { cwd: input.cwd, host: input.host, operation: "listPullRequests" };
      const toPage = (
        page: ReturnType<typeof toPullRequestRows>,
      ): GitHubPullRequestListPage & { readonly pageInfo: GraphQLClient.PageInfo } => ({
        items: page.rows.map((row) => row.item),
        rawCount: page.rawCount,
        endCursor: page.endCursor,
        pageInfo: { hasNextPage: page.endCursor !== null, endCursor: page.endCursor },
      });
      /**
       * Pages of up to a hundred until `rows` have arrived or GitHub has no more. Each page asks
       * for only the rows still missing, so the last one does not overshoot.
       */
      const collect = Effect.fn("GitHubPullRequestApi.collect")(function* (
        rows: number,
        page: (
          after: string | null,
          rows: number,
        ) => Effect.Effect<GitHubPullRequestListPage, GitHubPullRequestApiError>,
      ) {
        const countRows = (pages: ReadonlyArray<GitHubPullRequestListPage>) =>
          pages.reduce((total, read) => total + read.rawCount, 0);
        const pages: GitHubPullRequestListPage[] = [];
        const seen = new Set<string>();
        let after: string | null = null;
        let truncated = false;
        while (true) {
          const read: GitHubPullRequestListPage = yield* page(after, rows - countRows(pages));
          pages.push(read);
          const next = read.endCursor;
          if (next === null) break;
          // `truncated` also covers a cursor GitHub repeated before `rows` arrived.
          if (seen.has(next) || countRows(pages) >= rows) {
            truncated = true;
            break;
          }
          seen.add(next);
          after = next;
        }
        return {
          items: pages.flatMap((read) => read.items),
          rawCount: countRows(pages),
          truncated,
        };
      });
      const stacks = input.host.toLowerCase() === "github.com";
      const read = (
        continues: boolean,
        requestedRows = input.limit + 1,
      ): Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestApiError> =>
        collect(requestedRows, (after, rows) =>
          (continues
            ? client
                .PullRequestSearch({
                  q: query,
                  first: pageRows(rows),
                  after,
                  // Stack badges come from their own batched read below, for the rows that stay.
                  stacks: false,
                  stats: true,
                })
                .pipe(Effect.map((result) => toPage(toPullRequestRows(result.search))))
            : client
                .PullRequestList({
                  owner,
                  name,
                  states: LIST_STATES[input.state],
                  first: pageRows(rows),
                  after,
                  stacks: false,
                  stats: true,
                })
                .pipe(
                  Effect.map((result) =>
                    toPage(toPullRequestRows(result.repository?.pullRequests)),
                  ),
                )
          ).pipe(graphql(target)),
        ).pipe(
          Effect.flatMap(({ items: rawItems, rawCount, truncated: cutShort }) => {
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
              // Probe one raw row past the limit; malformed rows must not prematurely end paging.
              truncated:
                cutShort ||
                (continues
                  ? rawCount > input.limit
                  : items.length > input.limit || rawCount >= requestedRows),
              continues,
            });
          }),
        );
      // Unindexed repositories silently return no search rows; fall back to the repository listing.
      const hasQuery = (input.query?.trim().length ?? 0) > 0;
      return read(true).pipe(
        Effect.filterOrElse(
          (batch) => batch.items.length > 0 || input.cursor !== undefined || hasQuery,
          () => read(false),
        ),
        Effect.flatMap((batch) => {
          if (!stacks || batch.items.length === 0) return Effect.succeed(batch);
          return Effect.forEach(
            batch.items,
            (item) => {
              const lookup = pullRequestLookup({
                repository: input.repository,
                number: item.number,
              });
              if (lookup === null) return Effect.succeed(item);
              return GraphQLResolver.request(lookup, stackMembershipResolver).pipe(
                Effect.map((result) => {
                  const pullRequest = result.repository?.pullRequest;
                  const stack = pullRequest == null ? undefined : toStackMembership(pullRequest);
                  return stack === undefined ? item : { ...item, stack };
                }),
                Effect.catch((error) =>
                  Effect.logWarning("Pull request stack membership enrichment failed", {
                    operation: "listPullRequestStackMemberships",
                    host: input.host,
                    error: error._tag,
                  }).pipe(Effect.as(item)),
                ),
              );
            },
            { concurrency: "unbounded" },
          ).pipe(
            Effect.provideService(GitHubGraphQlClient.GitHubGraphQlTarget, {
              host: input.host,
              operation: "listPullRequestStackMemberships",
            }),
            Effect.map((items) => ({ ...batch, items })),
          );
        }),
      );
    },

    searchPullRequests: (input) => {
      const query = searchQuery(input);
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            cwd: input.cwd,
            operation: "searchPullRequests",
          }),
        );
      }
      const rows = Math.min(input.limit + 1, PULL_REQUEST_SEARCH_MAX_ROWS);
      return client
        .PullRequestSearch({
          q: query,
          first: rows,
          stacks: input.host.toLowerCase() === "github.com",
          stats: false,
        })
        .pipe(
          graphql({ ...input, operation: "searchPullRequests" }),
          Effect.map(({ search }) => {
            const page = toPullRequestRows(search);
            const items = page.rows.flatMap(({ item, repository }) =>
              repository === null ? [] : [{ ...item, repository }],
            );
            return {
              items: items.slice(0, input.limit),
              truncated: page.rawCount > input.limit || page.hasNextPage,
            };
          }),
        );
    },

    listPullRequestStats: Effect.fn("GitHubPullRequestApi.listPullRequestStats")(
      function* (input) {
        const lookups = input.changeRequests.map((changeRequest) => ({
          changeRequest,
          lookup: pullRequestLookup(changeRequest),
        }));
        if (lookups.some(({ lookup }) => lookup === null)) {
          return yield* new GitHubRepositorySelectorError({
            cwd: input.cwd,
            operation: "listPullRequestStats",
          });
        }
        const stats = yield* Effect.forEach(
          lookups,
          ({ changeRequest, lookup }) =>
            GraphQLResolver.request(lookup!, statsResolver).pipe(
              Effect.map((result) => {
                const pullRequest = result.repository?.pullRequest;
                return pullRequest == null
                  ? []
                  : [{ ...changeRequest, ...pullRequest } satisfies GitHubPullRequestStat];
              }),
              Effect.catchIf(isNotFoundOnly, () => Effect.succeed([])),
            ),
          { concurrency: "unbounded" },
        );
        return stats.flat();
      },
      (effect, input) =>
        effect.pipe((effect) =>
          batchedRead({ ...input, operation: "listPullRequestStats" }, effect),
        ),
    ),

    getPullRequestSummary,
    getPullRequestWatchFingerprint,

    getPullRequestDetail,
    getPullRequestPreview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const operation = "getPullRequestPreview";
      return client
        .PullRequestPreview({ owner, name, number: input.number })
        .pipe(
          graphql({ ...input, operation }),
          Effect.map(toPullRequestPreview),
          Effect.flatMap(found({ ...input, operation })),
        );
    },
    listWorkflowRunsRequiringApproval,

    getPullRequestStack: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      // Polled by the pull request sync for every linked pull request, so revalidate it.
      return revalidatedRestRead({
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
        // 404 means stacks are unsupported; other failures must preserve synced stacks for a retry.
        Effect.catchTags({
          GitHubApiNotFoundError: () => Effect.succeed(null),
        }),
      );
    },

    getPullRequestActivity: Effect.fn("GitHubPullRequestApi.getPullRequestActivity")(
      function* (input) {
        const { owner, name } = parseRepositorySelector(input.repository);
        let author: PullRequestActor | null = null;
        let commits: ReadonlyArray<PullRequestCommit> = [];
        const remarks: PullRequestComment[] = [];
        let commentsAfter: string | null = null;
        let reviewsAfter: string | null = null;
        let withComments = true;
        let withReviews = true;
        const target = { ...input, operation: "getPullRequestActivity" };
        for (let page = 0; page < REVIEW_THREAD_PAGES && (withComments || withReviews); page++) {
          const read: GitHubPullRequestActivityPage = yield* client
            .PullRequestActivity({
              owner,
              name,
              number: input.number,
              head: page === 0,
              withComments,
              commentsAfter,
              withReviews,
              reviewsAfter,
            })
            .pipe(
              graphql(target),
              Effect.map(toPullRequestActivityPage),
              Effect.flatMap(found(target)),
            );
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
      },
    ),

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
        return Effect.fail(new GitHubDiffCommitError({ cwd: input.cwd }));
      }
      if (input.cursor !== undefined) {
        const page = diffCursorPage(input.cursor);
        return page === null
          ? Effect.fail(new GitHubDiffCursorError({ cwd: input.cwd }))
          : filesPage(page);
      }
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
            response.truncated
              ? filesPage(1)
              : Effect.succeed({ patch: response.body, truncated: false, nextCursor: null }),
          ),
          // Above 300 changed files, GitHub returns 406; use the paged files API.
          Effect.catchTags({
            GitHubApiResponseError: (error) => filesPage(1).pipe(Effect.mapError(() => error)),
          }),
        );
    },

    getPullRequestDiffFileContents,

    getReviewThreadComments: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return client
        .ReviewThreadComments({
          owner,
          name,
          number: input.number,
          threadId: input.threadId,
          after: input.cursor,
        })
        .pipe(
          graphql({ ...input, operation: "getReviewThreadComments" }),
          Effect.map(toReviewThreadCommentsPage),
          Effect.flatMap(({ belongsToPullRequest, comments, nextCursor }) =>
            belongsToPullRequest
              ? Effect.succeed({ comments, nextCursor })
              : Effect.fail(
                  new GitHubSubjectScopeError({
                    cwd: input.cwd,
                    operation: "getReviewThreadComments",
                  }),
                ),
          ),
        );
    },

    listReviewThreadComments: Effect.fn("GitHubPullRequestApi.listReviewThreadComments")(
      function* (input) {
        const { owner, name } = parseRepositorySelector(input.repository);
        const target = { ...input, operation: "listReviewThreadComments" };
        let requestedReviewers = 50;
        const threadPage = (
          after: string | null,
        ): Effect.Effect<GitHubReviewThreadPage, GitHubPullRequestApiError> => {
          const read = () =>
            client.ReviewThreads({ owner, name, number: input.number, after, requestedReviewers });
          return read().pipe(
            Effect.catchIf(
              (error) => requestedReviewers > 0 && isRefusedRequestedReviewersOnly(error),
              () => {
                requestedReviewers = 0;
                return read();
              },
            ),
            graphql(target),
            Effect.map(toReviewThreadPage),
            Effect.flatMap(found(target)),
          );
        };
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

        if (dismissalCursor !== null) {
          let after: string | null = dismissalCursor;
          const pages: Array<{
            readonly dismissalsByReviewId: ReadonlyMap<string, string>;
          }> = [];
          const seen = new Set<string>();
          // Carries on from the thread read's own cursor, which `GraphQLClient.pages` cannot.
          while (after !== null && pages.length < REVIEW_THREAD_PAGES && !seen.has(after)) {
            seen.add(after);
            const read: {
              readonly dismissalsByReviewId: ReadonlyMap<string, string>;
              readonly nextCursor: string | null;
            } = yield* client
              .ReviewDismissals({ owner, name, number: input.number, after })
              .pipe(
                graphql(target),
                Effect.map(toReviewDismissalsPage),
                Effect.flatMap(found(target)),
              );
            pages.push(read);
            after = read.nextCursor;
          }
          for (const read of pages)
            for (const [id, message] of read.dismissalsByReviewId)
              dismissalsByReviewId.set(id, message);
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
      },
    ),

    listActorAvatars: (input) => {
      if (input.ids.length === 0) {
        return Effect.succeed(new Map<string, string>());
      }
      return client
        .ActorAvatars({ ids: input.ids })
        .pipe(graphql({ ...input, operation: "listActorAvatars" }), Effect.map(toActorAvatars));
    },

    getViewerAccess: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const operation = "getViewerAccess";
      return client
        .ViewerPermissions({ owner, name, number: input.number })
        .pipe(
          graphql({ ...input, operation }),
          Effect.map(toViewerPermissions),
          Effect.flatMap(found({ ...input, operation })),
        );
    },

    listReviewerCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const operation = "listReviewerCandidates";
      return client
        .ReviewerCandidates({ owner, name, number: input.number })
        .pipe(
          graphql({ ...input, operation, allowReserve: true }),
          Effect.map(toReviewerCandidates),
          Effect.flatMap(found({ ...input, operation })),
        );
    },

    setReviewerRequest: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
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
      const operation = "listLabelCandidates";
      return client
        .LabelCandidates({ owner, name, number: input.number })
        .pipe(
          graphql({ ...input, operation, allowReserve: true }),
          Effect.map(toLabelCandidates),
          Effect.flatMap(found({ ...input, operation })),
        );
    },

    setLabels: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
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
      if (input.action === "delete-branch") {
        return Effect.gen(function* () {
          if (input.stackNumber !== undefined) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "stack",
            });
          }
          const { owner, name } = parseRepositorySelector(input.repository);
          const target = { ...input, operation: "deletePullRequestBranch" };
          const branch = yield* client
            .PullRequestBranchToDelete({ owner, name, number: input.number })
            .pipe(
              graphql({ ...target, allowReserve: true }),
              Effect.map((result) => result.repository?.pullRequest ?? null),
              Effect.flatMap(found(target)),
            );
          if (branch.state === "OPEN") {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "open-pr",
            });
          }
          const repositoryId = branch.headRepository?.id;
          if (!repositoryId || !branch.headRefName || !branch.headRefOid) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "source-unavailable",
            });
          }
          if (branch.headRefName === branch.baseRefName) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "unsafe-branch",
            });
          }
          const ref = `refs/heads/${branch.headRefName}`;
          const source = yield* client
            .PullRequestSourceBranch({ repositoryId, ref })
            .pipe(graphql({ ...target, allowReserve: true }));
          const repository = source.node?.__typename === "Repository" ? source.node : null;
          if (repository === null) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "source-unavailable",
            });
          }
          if (repository.ref === null) return;
          if (
            repository.defaultBranchRef === null ||
            branch.headRefName === repository.defaultBranchRef.name
          ) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "unsafe-branch",
            });
          }
          if (repository.ref.target?.oid !== branch.headRefOid) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "head-changed",
            });
          }
          yield* client
            .DeletePullRequestBranch({
              input: {
                repositoryId,
                refUpdates: [
                  {
                    name: ref,
                    beforeOid: branch.headRefOid,
                    afterOid: "0000000000000000000000000000000000000000",
                  },
                ],
              },
            })
            .pipe(graphql(target));
        });
      }
      if (input.stackNumber !== undefined)
        return runGitHubStackAction({ ...input, stackNumber: input.stackNumber }).pipe(
          Effect.provideService(GitHubRest.GitHubRest, api),
          Effect.provideService(GitHubRequestPolicy.GitHubRequestPolicy, policy),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(SourceControlHost.SourceControlHost, sourceControlHost),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      if (input.action === "revert") {
        return pullRequestNodeId({ ...input, operation: "revertPullRequest" }).pipe(
          Effect.flatMap((pullRequestId) =>
            client
              .RevertPullRequest({ pullRequestId })
              .pipe(graphql({ ...input, operation: "revertPullRequest" })),
          ),
          Effect.asVoid,
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
      if (action in simpleActionMutations) {
        const mutate = simpleActionMutations[action as keyof typeof simpleActionMutations];
        return pullRequestNodeId({ ...input, operation: "runPullRequestAction" }).pipe(
          Effect.flatMap((pullRequestId) =>
            mutate(pullRequestId).pipe(graphql({ ...input, operation: "runPullRequestAction" })),
          ),
        );
      }
      return Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        // Fresh head and merge-queue state determine the mutation's revision and route.
        const target = { ...input, operation: "runPullRequestAction" };
        const state = yield* client
          .PullRequestActionState({
            owner,
            name,
            number: input.number,
            headRef: `refs/pull/${input.number}/head`,
          })
          .pipe(
            graphql({ ...target, allowReserve: true }),
            Effect.map((result) => result.repository?.pullRequest ?? null),
            Effect.flatMap(found(target)),
          );
        if (action === "update-branch") {
          if (state.baseRef?.compare?.behindBy === 0) return;
          return yield* client
            .UpdatePullRequestBranch({
              pullRequestId: state.id,
              expectedHeadOid: state.headRefOid,
              updateMethod: input.updateMethod === "rebase" ? "REBASE" : "MERGE",
            })
            .pipe(graphql(target), Effect.asVoid);
        }
        let body: string | undefined;
        let expectedHead: string | undefined;
        if (input.removeAgentCreditsOnMerge === true && input.mergeMethod !== "rebase") {
          const message = yield* client
            .PullRequestMergeMessage({
              owner,
              name,
              number: input.number,
              method: input.mergeMethod === "squash" ? "SQUASH" : "MERGE",
            })
            .pipe(
              graphql({ ...target, allowReserve: true }),
              Effect.map((result) => result.repository?.pullRequest ?? null),
              Effect.flatMap(found(target)),
            );
          // GitHub's merge queue chooses its own message and ignores custom text.
          if (!message.isMergeQueueEnabled) {
            const cleaned = removeAgentCredits(message.viewerMergeBodyText);
            if (cleaned !== message.viewerMergeBodyText) {
              body = cleaned;
              expectedHead = message.headRefOid;
            }
          }
        }
        // Merge queues always use auto-merge. A PR that became ready since detail loaded
        // merges directly, matching `gh pr merge --auto`.
        const auto =
          state.isMergeQueueEnabled === true ||
          (action === "enable-auto-merge" &&
            !IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? ""));
        const merge = {
          pullRequestId: state.id,
          mergeMethod: GRAPHQL_MERGE_METHODS[input.mergeMethod ?? "merge"],
          ...(expectedHead === undefined ? {} : { expectedHeadOid: expectedHead }),
          ...(body === undefined ? {} : { commitBody: body }),
        };
        yield* (
          auto
            ? client.EnablePullRequestAutoMerge({ input: merge }).pipe(Effect.asVoid)
            : client.MergePullRequest({ input: merge }).pipe(Effect.asVoid)
        ).pipe(graphql(target));
      });
    },

    commentOnPullRequest: (input) =>
      pullRequestNodeId({ ...input, operation: "commentOnPullRequest" }).pipe(
        Effect.flatMap((subjectId) =>
          client
            .AddComment({ subjectId, body: input.body })
            .pipe(graphql({ ...input, operation: "commentOnPullRequest" })),
        ),
        Effect.asVoid,
      ),

    submitReview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
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
      client
        .AddReviewThreadReply({ threadId: input.threadId, body: input.body })
        .pipe(graphql({ ...input, operation: "replyToReviewThread" }), Effect.asVoid),

    getPullRequestFilesViewed: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const target = { ...input, operation: "getPullRequestFilesViewed" };
      return readPages(
        GraphQLClient.pages(client.PullRequestFilesViewed, {
          variables: { owner, name, number: input.number },
          connection: (result) => {
            const page = toPullRequestFilesViewedPage(result);
            return {
              ...page,
              pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor },
            };
          },
        }),
        {
          ...target,
          maxPages: FILES_VIEWED_MAX_PAGES,
          hasNextPage: (page) => page.nextCursor !== null,
        },
      ).pipe(
        graphql(target),
        Effect.map(({ pages, truncated }) => ({
          files: pages.flatMap((page) => page.files),
          truncated,
        })),
      );
    },

    getPullRequestFileStats: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const target = { ...input, operation: "getPullRequestFileStats" };
      return readPages(
        GraphQLClient.pages(client.PullRequestFileStats, {
          variables: { owner, name, number: input.number },
          connection: (result) => {
            const page = toPullRequestFileStatsPage(result);
            return {
              ...page,
              pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor },
            };
          },
        }),
        {
          ...target,
          maxPages: FILES_VIEWED_MAX_PAGES,
          hasNextPage: (page) => page.nextCursor !== null,
        },
      ).pipe(
        graphql(target),
        Effect.map(({ pages, truncated }) => ({
          files: pages.flatMap((page) => page.files),
          truncated,
        })),
      );
    },

    setPullRequestFilesViewed: (input) => {
      if (input.files.length === 0) return Effect.void;
      const target = { ...input, operation: "setPullRequestFilesViewed" };
      return pullRequestNodeId(target).pipe(
        Effect.flatMap((pullRequestId) =>
          // Top-level mutation fields run in order, so the last toggle for a path wins.
          Effect.forEach(
            input.files,
            (file) =>
              GraphQLResolver.request(
                { pullRequestId, path: file.path, viewed: file.viewed },
                setFileViewedResolver,
              ),
            { concurrency: "unbounded", discard: true },
          ),
        ),
        graphql(target),
      );
    },

    setReviewThreadResolution: (input) =>
      (input.resolved
        ? client.ResolveReviewThread({ threadId: input.threadId }).pipe(Effect.asVoid)
        : client.UnresolveReviewThread({ threadId: input.threadId }).pipe(Effect.asVoid)
      ).pipe(graphql({ ...input, operation: "setReviewThreadResolution" })),

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
                        cwd: input.cwd,
                        operation: "setReaction",
                      }),
                    ),
              ),
            );
      return subjectId.pipe(
        Effect.flatMap((subjectId) => {
          const variables = { subjectId, content: gitHubReactionContent(input.content) };
          return (
            input.reacted
              ? client.AddReaction(variables).pipe(Effect.asVoid)
              : client.RemoveReaction(variables).pipe(Effect.asVoid)
          ).pipe(graphql({ ...input, operation: "setReaction" }));
        }),
      );
    },

    updatePullRequest: (input) =>
      pullRequestNodeId({ ...input, operation: "updatePullRequest" }).pipe(
        Effect.flatMap((pullRequestId) =>
          client
            .UpdatePullRequest({
              pullRequestId,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            })
            .pipe(graphql({ ...input, operation: "updatePullRequest" })),
        ),
        Effect.asVoid,
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
                  cwd: input.cwd,
                  operation: "updateComment",
                }),
              ),
        ),
        Effect.flatMap((commentId) => {
          const variables = { commentId, body: input.body };
          return (
            input.kind === "issue-comment"
              ? client.UpdateIssueComment(variables).pipe(Effect.asVoid)
              : client.UpdateReviewComment(variables).pipe(Effect.asVoid)
          ).pipe(graphql({ ...input, operation: "updateComment" }));
        }),
      ),
  });
});

export const layer = Layer.effect(GitHubPullRequestApi, make);

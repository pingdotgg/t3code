import { isCommitSha, normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
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
  type PullRequestLabel,
  type PullRequestLabelCandidateList,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateMethod,
  type PullRequestPreview,
} from "@t3tools/contracts";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
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
  toLabelCandidates,
  toRepositoryAuthors,
  toRepositoryLabels,
  toPullRequestActivityPage,
  toPullRequestCommitStats,
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

import { GitHubPullRequestReadError, GitHubViewerLoginUnavailableError, GitHubDiffCursorError, GitHubDiffCommitError, GitHubDiffRevisionsUnavailableError, GitHubDiffFileContentsUnavailableError, GitHubRepositorySelectorError, GitHubSubjectScopeError, GitHubWorkflowApprovalRefusedError, GitHubWorkflowApprovalHeadUnavailableError, GitHubWorkflowApprovalHeadChangedError, GitHubBranchDeletionRefusedError } from "./githubPullRequestErrors.ts";
import {
  CHECK_CONTEXT_PAGES,
  DIFF_FILES_PAGE_SIZE,
  DIFF_FILE_MAX_OUTPUT_BYTES,
  DIFF_MAX_OUTPUT_BYTES,
  DIFF_TIMEOUT,
  FILES_VIEWED_MAX_PAGES,
  FILES_VIEWED_PER_REQUEST,
  isGraphQlClientError,
  isNotFoundOnly,
  isRefusedRequestedReviewersOnly,
  LIST_STATES,
  NODE_ID_CACHE_CAPACITY,
  PULL_REQUEST_FALLBACK_MAX_ROWS,
  REVIEW_THREAD_PAGES,
  STAT_ALIASES_PER_REQUEST,
  SUMMARY_BATCH_WINDOW,
  type GitHubPullRequestDiffSlice,
} from "./githubPullRequestSupport.ts";
import {
  decodeMergeBase,
  decodeRevisionRefs,
  filterQualifiers,
  GRAPHQL_MERGE_METHODS,
  matchesFilters,
  matchesUnsortedListing,
  parseRepositorySelector,
  PullRequestGraphQLGroup,
  type RestReadInput,
  searchPhrase,
  searchQuery,
} from "./githubPullRequestQuery.ts";
import type { GitHubPullRequestApiError } from "./githubPullRequestErrors.ts";
import type { GitHubPullRequestApi } from "./GitHubPullRequestApi.ts";


export interface MakePullRequestResolversDeps {
  readonly client: GraphQLClient.FromGroup<typeof PullRequestGraphQLGroup>;
  readonly readError: (cwd: string, operation: string, cause: unknown) => GitHubPullRequestReadError;
}

export const makePullRequestResolvers = (deps: MakePullRequestResolversDeps) => {
  const { client, readError } = deps;
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
  return {
    batchedRead,
    getPullRequestSummary,
    getPullRequestWatchFingerprint,
    statsResolver,
    stackMembershipResolver,
  };
};

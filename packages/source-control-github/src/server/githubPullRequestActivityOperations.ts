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
import { PullRequestGraphQLGroup } from "./githubPullRequestQuery.ts";
import type { PullRequestReads } from "./githubPullRequestReads.ts";
import type { GitHubPullRequestApi } from "./GitHubPullRequestApi.ts";
import {
  DIFF_MAX_OUTPUT_BYTES,
  DIFF_TIMEOUT,
  isNotFoundOnly,
  isRefusedRequestedReviewersOnly,
  LIST_STATES,
  REVIEW_THREAD_PAGES,
  PULL_REQUEST_FALLBACK_MAX_ROWS,
  type GitHubPullRequestDiffSlice,
  type GitHubPullRequestFileStats,
  type GitHubPullRequestFilesViewed,
  type GitHubPullRequestListBatch,
  type GitHubPullRequestListPage,
  type GitHubPullRequestSearchBatch,
  type GitHubPullRequestStat,
} from "./githubPullRequestSupport.ts";
import {
  diffCursorPage,
  filterQualifiers,
  matchesFilters,
  matchesUnsortedListing,
  parseRepositorySelector,
  searchQuery,
} from "./githubPullRequestQuery.ts";
import type { GitHubPullRequestApiError } from "./githubPullRequestErrors.ts";

export interface MakePullRequestActivityOperationsDeps {
  readonly client: GraphQLClient.FromGroup<typeof PullRequestGraphQLGroup>;
  readonly graphql: PullRequestReads["graphql"];
  readonly found: PullRequestReads["found"];
}

export const makePullRequestActivityOperations = (
  deps: MakePullRequestActivityOperationsDeps,
): Pick<
  GitHubPullRequestApi["Service"],
  | "getPullRequestActivity"
> => {
  const { client, graphql, found } = deps;
  return ({
  getPullRequestActivity: Effect.fn("GitHubPullRequestApi.getPullRequestActivity")(
    function* (input) {
      const { owner, name } = parseRepositorySelector(input.repository);
      let author: PullRequestActor | null = null;
      let commits: ReadonlyArray<PullRequestCommit> = [];
      let nonMergeCommitIds: ReadonlyArray<string> = [];
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
          nonMergeCommitIds = read.nonMergeCommitIds;
        }
        remarks.push(...read.remarks);
        commentsAfter = read.nextCommentsCursor;
        reviewsAfter = read.nextReviewsCursor;
        withComments = withComments && commentsAfter !== null;
        withReviews = withReviews && reviewsAfter !== null;
      }
      const emptyStats = toPullRequestCommitStats({ nodes: [] });
      const commitStats =
        nonMergeCommitIds.length === 0
          ? emptyStats
          : yield* client.PullRequestCommitStats({ ids: nonMergeCommitIds }).pipe(
              graphql(target),
              Effect.map(toPullRequestCommitStats),
              Effect.orElseSucceed(() => emptyStats),
            );
      return {
        author,
        comments: remarks.toSorted((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ),
        commits: commits.map((commit) => ({ ...commit, ...commitStats.get(commit.oid) })),
      } satisfies GitHubPullRequestActivity;
    },
  ),
  });
};

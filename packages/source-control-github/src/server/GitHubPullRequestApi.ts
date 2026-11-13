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
export { GitHubPullRequestReadError, GitHubViewerLoginUnavailableError, GitHubDiffCursorError, GitHubDiffCommitError, GitHubDiffRevisionsUnavailableError, GitHubDiffFileContentsUnavailableError, GitHubRepositorySelectorError, GitHubSubjectScopeError, GitHubWorkflowApprovalRefusedError, GitHubWorkflowApprovalHeadUnavailableError, GitHubWorkflowApprovalHeadChangedError, GitHubBranchDeletionRefusedError } from "./githubPullRequestErrors.ts";
import type { GitHubPullRequestApiError } from "./githubPullRequestErrors.ts";
export type { GitHubPullRequestApiError } from "./githubPullRequestErrors.ts";

import { isGraphQlClientError, isNotFoundOnly, isRefusedRequestedReviewersOnly } from "./githubPullRequestSupport.ts";
import { makePullRequestReads } from "./githubPullRequestReads.ts";
import { makePullRequestReadOperations } from "./githubPullRequestReadOperations.ts";
import { makePullRequestWriteOperations } from "./githubPullRequestWriteOperations.ts";
import { makePullRequestActivityOperations } from "./githubPullRequestActivityOperations.ts";

import { DIFF_MAX_OUTPUT_BYTES, DIFF_TIMEOUT, DIFF_FILE_MAX_OUTPUT_BYTES, LIST_STATES, PULL_REQUEST_FALLBACK_MAX_ROWS, DIFF_FILES_PAGE_SIZE, FILES_VIEWED_MAX_PAGES, FILES_VIEWED_PER_REQUEST, NODE_ID_CACHE_CAPACITY, REVIEW_THREAD_PAGES, CHECK_CONTEXT_PAGES, STAT_ALIASES_PER_REQUEST, SUMMARY_BATCH_WINDOW } from "./githubPullRequestSupport.ts";
export { DIFF_MAX_OUTPUT_BYTES, DIFF_TIMEOUT, DIFF_FILE_MAX_OUTPUT_BYTES, LIST_STATES, PULL_REQUEST_FALLBACK_MAX_ROWS, DIFF_FILES_PAGE_SIZE, FILES_VIEWED_MAX_PAGES, FILES_VIEWED_PER_REQUEST, NODE_ID_CACHE_CAPACITY, REVIEW_THREAD_PAGES, CHECK_CONTEXT_PAGES, STAT_ALIASES_PER_REQUEST, SUMMARY_BATCH_WINDOW } from "./githubPullRequestSupport.ts";
import type { GitHubPullRequestListPage, GitHubPullRequestListBatch, GitHubPullRequestStat, GitHubPullRequestSearchBatch, GitHubPullRequestDiffSlice, GitHubPullRequestFilesViewed, GitHubPullRequestFileStats } from "./githubPullRequestSupport.ts";
export type { GitHubPullRequestListPage, GitHubPullRequestListBatch, GitHubPullRequestStat, GitHubPullRequestSearchBatch, GitHubPullRequestDiffSlice, GitHubPullRequestFilesViewed, GitHubPullRequestFileStats } from "./githubPullRequestSupport.ts";

export class GitHubPullRequestApi extends Context.Service<
  GitHubPullRequestApi,
  {
    readonly withVerifiedCredential: <A, E, R>(
      input: { readonly cwd: string; readonly host: string; readonly repository?: string },
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

    readonly listRepositoryLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly query?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestLabel>; readonly truncated: boolean },
      GitHubPullRequestApiError
    >;

    readonly searchRepositoryAuthors: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly query?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestActor>; readonly truncated: boolean },
      GitHubPullRequestApiError
    >;

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
      readonly maintainerCanModify?: boolean | undefined;
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

import { parseRepositorySelector } from "./githubPullRequestQuery.ts";

/** Bound decimal length to prevent exponential notation in request paths. */
import { diffCursorPage, searchPhrase, REVIEW_QUALIFIERS, qualifierValue, filterQualifiers, matchesFilters, matchesUnsortedListing, SEARCH_REPOSITORY, searchQuery, decodeRevisionRefs, decodeMergeBase, GRAPHQL_MERGE_METHODS, PullRequestGraphQLGroup } from "./githubPullRequestQuery.ts";
export { diffCursorPage, searchPhrase, REVIEW_QUALIFIERS, qualifierValue, filterQualifiers, matchesFilters, matchesUnsortedListing, SEARCH_REPOSITORY, searchQuery, decodeRevisionRefs, decodeMergeBase, GRAPHQL_MERGE_METHODS, PullRequestGraphQLGroup } from "./githubPullRequestQuery.ts";
import type { RestReadInput } from "./githubPullRequestQuery.ts";
export type { RestReadInput } from "./githubPullRequestQuery.ts";
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const appAccess = yield* GitHubAppAccess.GitHubAppAccess;
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
    function* (input: {
      readonly cwd: string;
      readonly host: string;
      readonly repository?: string;
    }) {
      const unavailable = () => new GitHubViewerLoginUnavailableError({ cwd: input.cwd });
      const host = input.host.toLowerCase();
      // A pinned credential is never handed on to another, so pick one that reaches the repository.
      const { token, fingerprint: key } =
        input.repository === undefined
          ? yield* api.credential(host)
          : yield* appAccess.credentialFor(host, input.repository);
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
                    // The enclosing operation owns the span for this inline handler.
                    GitHubApiResponseError: Effect.fnUntraced(function* (error) {
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

  const reads = yield* makePullRequestReads({ api, client, policy, readError });
  const { graphql, setFileViewedResolver, found, readPages, pullRequestNodeId, subjectBelongsToPullRequest, restRead, revalidatedRestRead, diffFilesPage, getPullRequestDiffFileContents, readAllCheckContexts, getPullRequestDetail, listHeadsByBranch, listActionRequiredRuns, listWorkflowRunsRequiringApproval, simpleActionMutations, batchedRead, getPullRequestSummary, getPullRequestWatchFingerprint, statsResolver, stackMembershipResolver } = reads;

  return GitHubPullRequestApi.of({
    withVerifiedCredential,
    revalidateChecks,
    getRoutingIdentity,
    ...makePullRequestReadOperations({ api, reads, client, getRoutingIdentity }),
    ...makePullRequestActivityOperations({ client, graphql, found }),
    ...makePullRequestWriteOperations({ api, appAccess, client, fileSystem, httpClient, policy, sourceControlHost, reads }),
  });
});

export const layer = Layer.effect(GitHubPullRequestApi, make);

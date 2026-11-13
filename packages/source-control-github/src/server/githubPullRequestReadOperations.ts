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

export interface MakePullRequestReadOperationsDeps {
  readonly api: import("./GitHubRest.ts").GitHubRest["Service"];
  readonly reads: PullRequestReads;
  readonly client: GraphQLClient.FromGroup<typeof PullRequestGraphQLGroup>;
  readonly getRoutingIdentity: GitHubPullRequestApi["Service"]["getRoutingIdentity"];
}

export const makePullRequestReadOperations = (
  deps: MakePullRequestReadOperationsDeps,
): Pick<
  GitHubPullRequestApi["Service"],
  | "getViewerLogin"
  | "listPullRequests"
  | "searchPullRequests"
  | "listPullRequestStats"
  | "getPullRequestPreview"
  | "getPullRequestStack"
  | "getPullRequestDiff"
  | "getReviewThreadComments"
  | "listReviewThreadComments"
  | "getViewerAccess"
  | "listReviewerCandidates"
  | "setReviewerRequest"
  | "listLabelCandidates"
  | "listRepositoryLabels"
  | "getPullRequestSummary"
  | "getPullRequestWatchFingerprint"
  | "getPullRequestDetail"
  | "listWorkflowRunsRequiringApproval"
  | "getPullRequestDiffFileContents"
  | "searchRepositoryAuthors"
> => {
  const { api, reads, client, getRoutingIdentity } = deps;
  const {
    graphql,
    found,
    readPages,
    restRead,
    revalidatedRestRead,
    diffFilesPage,
    getPullRequestDiffFileContents,
    batchedRead,
    getPullRequestDetail,
    getPullRequestSummary,
    getPullRequestWatchFingerprint,
    listWorkflowRunsRequiringApproval,
    statsResolver,
    stackMembershipResolver,
  } = reads;
  return ({
  getViewerLogin: Effect.fn("GitHubPullRequestApi.getViewerLogin")(function (input) {
    return getRoutingIdentity(input).pipe(Effect.map((identity) => identity.viewer));
  }),

  listPullRequests: Effect.fn("GitHubPullRequestApi.listPullRequests")(function (input) {
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
    const listed = read(true).pipe(
      Effect.filterOrElse(
        (batch) => batch.items.length > 0 || input.cursor !== undefined || hasQuery,
        () => read(false),
      ),
      Effect.filterOrElse(
        (batch) => !stacks || batch.items.length === 0,
        (batch) =>
          Effect.forEach(
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
          ),
      ),
    );
    // GitHub answers a private repository the token cannot see as missing, and its error names
    // the credential that request carried. A personal credential is pinned for the whole
    // read, so a token changed mid-read does not split it; the app keeps the policy's fallback.
    const host = normalizeHost(input.host);
    return api.credential(host).pipe(
      Effect.flatMap(({ token, fingerprint, source }) =>
        source === undefined || source === "app"
          ? listed
          : listed.pipe(
              Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
                host,
                token,
                credentialFingerprint: fingerprint,
                source,
              }),
            ),
      ),
    );
  }),

  searchPullRequests: Effect.fn("GitHubPullRequestApi.searchPullRequests")(function* (input) {
    const query = searchQuery(input);
    if (query === null) {
      return yield* new GitHubRepositorySelectorError({
        cwd: input.cwd,
        operation: "searchPullRequests",
      });
    }
    const rows = Math.min(input.limit + 1, PULL_REQUEST_SEARCH_MAX_ROWS);
    return yield* client
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
  }),

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
  getPullRequestPreview: Effect.fn("GitHubPullRequestApi.getPullRequestPreview")(
    function (input) {
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
  ),
  listWorkflowRunsRequiringApproval,

  getPullRequestStack: Effect.fn("GitHubPullRequestApi.getPullRequestStack")(function (input) {
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
  }),

  getPullRequestDiff: Effect.fn("GitHubPullRequestApi.getPullRequestDiff")(function (input) {
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
  }),

  getPullRequestDiffFileContents,

  getReviewThreadComments: Effect.fn("GitHubPullRequestApi.getReviewThreadComments")(
    function (input) {
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
  ),

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
        commits,
        viewer,
      };
    },
  ),

  getViewerAccess: Effect.fn("GitHubPullRequestApi.getViewerAccess")(function (input) {
    const { owner, name } = parseRepositorySelector(input.repository);
    const operation = "getViewerAccess";
    return client
      .ViewerPermissions({ owner, name, number: input.number })
      .pipe(
        graphql({ ...input, operation }),
        Effect.map(toViewerPermissions),
        Effect.flatMap(found({ ...input, operation })),
      );
  }),

  listReviewerCandidates: Effect.fn("GitHubPullRequestApi.listReviewerCandidates")(
    function (input) {
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
  ),

  setReviewerRequest: Effect.fn("GitHubPullRequestApi.setReviewerRequest")(function (input) {
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
  }),

  listLabelCandidates: Effect.fn("GitHubPullRequestApi.listLabelCandidates")(function (input) {
    const { owner, name } = parseRepositorySelector(input.repository);
    const operation = "listLabelCandidates";
    return client
      .LabelCandidates({ owner, name, number: input.number })
      .pipe(
        graphql({ ...input, operation, allowReserve: true }),
        Effect.map(toLabelCandidates),
        Effect.flatMap(found({ ...input, operation })),
      );
  }),

  listRepositoryLabels: Effect.fn("GitHubPullRequestApi.listRepositoryLabels")(function (input) {
    const { owner, name } = parseRepositorySelector(input.repository);
    const operation = "listRepositoryLabels";
    return client
      .RepositoryLabels({ owner, name, query: input.query ?? null })
      .pipe(
        graphql({ ...input, operation, allowReserve: true }),
        Effect.map(toRepositoryLabels),
        Effect.flatMap(found({ ...input, operation })),
      );
  }),

  searchRepositoryAuthors: Effect.fn("GitHubPullRequestApi.searchRepositoryAuthors")(
    function (input) {
      const { owner, name } = parseRepositorySelector(input.repository);
      const operation = "searchRepositoryAuthors";
      return client
        .RepositoryAuthors({ owner, name, query: input.query ?? null })
        .pipe(
          graphql({ ...input, operation, allowReserve: true }),
          Effect.map(toRepositoryAuthors),
          Effect.flatMap(found({ ...input, operation })),
        );
    },
  ),
});
};

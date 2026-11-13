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
import { makePullRequestResolvers } from "./githubPullRequestResolvers.ts";
import type { GitHubPullRequestApi } from "./GitHubPullRequestApi.ts";

export interface MakePullRequestReadsDeps {
  readonly api: import("./GitHubRest.ts").GitHubRest["Service"];
  readonly client: GraphQLClient.FromGroup<typeof PullRequestGraphQLGroup>;
  readonly policy: import("./GitHubRequestPolicy.ts").GitHubRequestPolicy["Service"];
  readonly readError: (cwd: string, operation: string, cause: unknown) => GitHubPullRequestReadError;
}

export type PullRequestReads = Effect.Success<ReturnType<typeof makePullRequestReads>>;

export const makePullRequestReads = Effect.fn("makePullRequestReads")(function* (
  deps: MakePullRequestReadsDeps,
) {
  const { api, client, policy, readError } = deps;
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
              host: normalizeHost(input.host),
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
    const host = normalizeHost(input.host);
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
      // A pull request's patch runs from the merge base, and the base branch may have moved on
      // since, so its old side is read there. Page 2 of a compare leaves out the file list; a
      // failed read falls back to the base branch tip.
      const oldRef =
        input.commit === undefined && input.changeType !== "new"
          ? yield* api
              .rest({
                host: input.host,
                operation: "getPullRequestDiffFileContents",
                path: `repos/${owner}/${name}/compare/${baseRef}...${headRef}?per_page=1&page=2`,
                timeout: DIFF_TIMEOUT,
              })
              .pipe(
                Effect.map((response) =>
                  decodeMergeBase(response.body).pipe(
                    Option.map((compare) => compare.merge_base_commit.sha),
                    Option.filter(isCommitSha),
                    Option.getOrElse(() => baseRef ?? ""),
                  ),
                ),
                Effect.orElseSucceed(() => baseRef ?? ""),
              )
          : (baseRef ?? "");

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
          input.changeType === "new" ? Effect.succeed("") : readFile(oldRef, input.oldPath),
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
            Effect.filterOrFail(
              (runs) => !(runs.length > workflowApprovalLimit),
              (runs) =>
                new GitHubWorkflowApprovalRefusedError({
                  cwd: input.cwd,
                  number: input.number,
                  reason: "run-list-truncated",
                  observedCount: runs.length,
                  limit: workflowApprovalLimit,
                }),
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
  const { batchedRead, getPullRequestSummary, getPullRequestWatchFingerprint, statsResolver, stackMembershipResolver } = makePullRequestResolvers({ client, readError });
  // GitHub has no bulk viewed-file mutation; aliases combine individual paths into one request.
  const setFileViewedResolver = GraphQLResolver.aliased(client.SetFileViewed, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(RequestResolver.batchN(FILES_VIEWED_PER_REQUEST));
  return { graphql, setFileViewedResolver, found, readPages, pullRequestNodeId, subjectBelongsToPullRequest, restRead, revalidatedRestRead, diffFilesPage, getPullRequestDiffFileContents, readAllCheckContexts, getPullRequestDetail, listHeadsByBranch, listActionRequiredRuns, listWorkflowRunsRequiringApproval, simpleActionMutations, batchedRead, getPullRequestSummary, getPullRequestWatchFingerprint, statsResolver, stackMembershipResolver };
});

import { resolvePullRequestAuthorFilter, SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type {
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { rollupCheckStatuses } from "@t3tools/source-control-core/server/pullRequestChecks";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestSummary,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import type { BitbucketPullRequest } from "./bitbucketPullRequestJson.ts";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true, searchCandidates: false },
  edit: { changeRequest: true, comment: true },
  // Bitbucket PR properties are shared, not per-reader viewed marks.
  viewedFiles: "environment",
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Bitbucket needs API credentials on the server. Add them in Settings → Source control & issues.",
  unauthenticated:
    "Bitbucket rejected the configured credentials. Check them in Settings → Source control & issues.",
};

/**
 * Bitbucket lets the author of a pull request decline their own with no more than read access,
 * and the permission response says nothing about who opened this one — so withholding the
 * control from the one person entitled to it is the worse of the two mistakes.
 */
export function bitbucketViewerPermissions(input: {
  readonly canWrite: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter((action) => action !== "merge" || input.canWrite),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
  };
}

export function bitbucketProviderFailure(
  error: BitbucketPullRequestApi.BitbucketPullRequestApiError,
): PullRequestProviderFailure {
  if (
    (error._tag === "BitbucketResponseError" && error.status === 401) ||
    error._tag === "SettingsSecretUnresolvedError"
  ) {
    return { reason: "unauthenticated" };
  }
  if (error._tag === "SourceControlRateLimitPausedError") {
    return { reason: "rate-limited", retryAt: error.retryAt };
  }
  if (
    (error._tag === "BitbucketResponseError" || error._tag === "BitbucketResponseBodyReadError") &&
    error.status === 429
  ) {
    return {
      reason: "rate-limited",
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    };
  }
  if (
    (error._tag === "BitbucketResponseError" || error._tag === "BitbucketResponseBodyReadError") &&
    error.status === 404
  ) {
    return { reason: "not-found" };
  }
  return { reason: "failed" };
}

function toChangeRequest(pullRequest: BitbucketPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    ...(pullRequest.headSha ? { headSha: pullRequest.headSha } : {}),
    ...(pullRequest.headRepositoryNameWithOwner
      ? { headRepositoryNameWithOwner: pullRequest.headRepositoryNameWithOwner }
      : {}),
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    reviewDecision: pullRequest.reviewDecision,
    labels: [],
  };
}

// A finished result for a head commit only changes on a re-run. A pending one is about to change,
// and so is an empty one: CI may simply not have started yet.
const PENDING_CHECKS_TTL = Duration.minutes(1);
const FINISHED_CHECKS_TTL = Duration.minutes(30);

function checksStateOf(checks: ReadonlyArray<PullRequestCheck>): PullRequestChecksState | null {
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

/** The write's reply has no `closed_on`, line counts, or conflict state, so those stay absent. */
function toActionSummary(pullRequest: BitbucketPullRequest): ProviderChangeRequestSummary {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    updatedAt: pullRequest.updatedAt,
    ...(pullRequest.headSha ? { headSha: pullRequest.headSha } : {}),
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
  const servesHost = yield* BitbucketApi.BitbucketServesHost.pipe(Effect.orDie);

  const fail =
    (operation: string) => (error: BitbucketPullRequestApi.BitbucketPullRequestApiError) =>
      new PullRequestProviderError({
        provider: SourceControlProviderKind.make("bitbucket"),
        operation,
        ...bitbucketProviderFailure(error),
        detail: error._tag === "SettingsSecretUnresolvedError" ? error.message : error.detail,
        cause: error,
      });

  const recoverRead = <A>(
    read: Effect.Effect<A, BitbucketPullRequestApi.BitbucketPullRequestApiError>,
    fallback: A,
  ) => {
    const recover = () => Effect.succeed(fallback);
    return Effect.catchTags(read, {
      BitbucketResponseError: (error) => (error.status === 429 ? Effect.fail(error) : recover()),
      BitbucketUntrustedUrlError: recover,
      BitbucketRepositoryLocatorError: recover,
      BitbucketRequestError: recover,
      BitbucketResponseBodyReadError: (error) =>
        error.status === 429 ? Effect.fail(error) : recover(),
      BitbucketResponseDecodeError: recover,
      BitbucketRepositoryVcsResolveError: recover,
      BitbucketRepositoryRemotesListError: recover,
      BitbucketRepositoryRemoteNotFoundError: recover,
      BitbucketPullRequestBodyReadError: recover,
      BitbucketCheckoutError: recover,
      BitbucketPullRequestReadError: recover,
      BitbucketViewerUnavailableError: recover,
      BitbucketRepositoryUnsupportedError: recover,
      BitbucketDiffCommitError: recover,
    });
  };

  // Include the head commit so a push bypasses cached statuses from the previous head.
  const checksStates = yield* Cache.makeWith(
    (key: string) => {
      const [repository, number] = JSON.parse(key) as [string, number, string];
      return api.listChecks({ repository, number }).pipe(Effect.map(checksStateOf));
    },
    {
      capacity: 1000,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? exit.value === "pending" || exit.value === null
            ? PENDING_CHECKS_TTL
            : FINISHED_CHECKS_TTL
          : Duration.zero,
    },
  );

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("bitbucket"),
    capabilities: CAPABILITIES,
    servesHost,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    readsPublicHostWithoutCheckout: true,

    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    // One span around the listing, so the eligibility check, the cache and the concurrent reads
    // read as a single operation next to the API's own request spans.
    listChangeRequests: Effect.fn("BitbucketPullRequestProvider.listChangeRequests")(
      function (input) {
        const filters = input.filters;
        const filterAuthor =
          filters?.author === undefined
            ? undefined
            : resolvePullRequestAuthorFilter(filters.author, input.viewer).toLowerCase();
        return api
          .listPullRequests({
            repository: input.repository,
            state: input.state,
            limit: input.limit,
            query: input.query,
            cursor: input.cursor,
            author:
              filters?.author === undefined
                ? undefined
                : resolvePullRequestAuthorFilter(filters.author, input.viewer),
            draft: filters?.draft === undefined ? undefined : filters.draft === "only",
          })
          .pipe(
            Effect.flatMap((batch) => {
              // A listing carries no check results, so an open row's are read here (they feed the
              // row's CI icon, the checks grouping and the checks filter). Closed rows are read
              // only for the filter.
              const readItems = Effect.forEach(
                batch.items,
                (pullRequest) => {
                  const item = toChangeRequest(pullRequest);
                  if (
                    (pullRequest.state !== "open" && filters?.checks === undefined) ||
                    (filters?.review !== undefined &&
                      (filters.review === "none"
                        ? pullRequest.reviewDecision !== null
                        : pullRequest.reviewDecision !== filters.review)) ||
                    (filters?.draft !== undefined &&
                      pullRequest.isDraft !== (filters.draft === "only")) ||
                    (filterAuthor !== undefined &&
                      pullRequest.author?.login.toLowerCase() !== filterAuthor)
                  ) {
                    return Effect.succeed(item);
                  }
                  // Without a head revision a push cannot invalidate a cached answer, so the
                  // row is read every time.
                  const read =
                    pullRequest.headSha === null
                      ? api
                          .listChecks({ repository: input.repository, number: pullRequest.number })
                          .pipe(Effect.map(checksStateOf))
                      : Cache.get(
                          checksStates,
                          JSON.stringify([
                            input.repository,
                            pullRequest.number,
                            pullRequest.headSha,
                          ]),
                        );
                  return read.pipe(Effect.map((checksState) => ({ ...item, checksState })));
                },
                { concurrency: 5 },
              );
              return readItems.pipe(
                // Keep excluded rows so the service advances its cursor past every scanned row.
                Effect.map((items) => ({ items, truncated: batch.truncated, continues: true })),
              );
            }),
            Effect.mapError(fail("listChangeRequests")),
          );
      },
    ),

    getChangeRequestChecks: (input) =>
      Effect.all([api.getPullRequest(input), api.listChecks(input)], { concurrency: 2 }).pipe(
        Effect.map(([pullRequest, checks]) => ({ state: pullRequest.state, checks })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    getChangeRequestPreview: (input) =>
      api.getPullRequest({ repository: input.repository, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequestPreview")),
        Effect.map((pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
          createdAt: pullRequest.createdAt,
        })),
      ),

    getChangeRequest: (input) => {
      const target = { repository: input.repository, number: input.number };
      return Effect.all(
        [
          api.getPullRequest(target),
          api.getDiffStat(target),
          recoverRead(api.getMergeability(target), "unknown" as const),
          // Null keeps the last known checks state; an empty list would claim no checks exist.
          recoverRead(api.listChecks(target), null),
          recoverRead(api.getRepositoryPermission(target), true),
        ],
        { concurrency: 5 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([
            pullRequest,
            diffStat,
            mergeability,
            checks,
            canWrite,
          ]): ProviderChangeRequestDetail => ({
            ...toChangeRequest(pullRequest),
            mergeability,
            additions: diffStat.additions,
            deletions: diffStat.deletions,
            changedFiles: diffStat.changedFiles,
            body: pullRequest.body,
            mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
            closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
            reviewers: pullRequest.reviewers,
            checks: checks ?? [],
            ...(checks === null
              ? {}
              : { checksState: rollupCheckStatuses(checks.map((check) => check.status)) }),
            // Bitbucket exposes no strategy permissions; unsupported strategies fail at merge.
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            viewerPermissions: bitbucketViewerPermissions({ canWrite }),
          }),
        ),
      );
    },

    getChangeRequestActivity: (input) => {
      const target = { repository: input.repository, number: input.number };
      return Effect.all(
        [
          api.getPullRequest(target),
          recoverRead(api.listComments(target), { comments: [], threads: [], truncated: true }),
          recoverRead(api.listCommits(target), []),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([pullRequest, comments, commits]): ProviderChangeRequestActivity => ({
          comments: [...comments.comments, ...pullRequest.reviews].toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          ),
          commentCount: comments.comments.length + pullRequest.reviews.length,
          commentsTruncated: comments.truncated,
          reviewThreads: comments.threads,
          commits,
        })),
      );
    },

    getViewerPermissions: (input) =>
      api.getRepositoryPermission({ repository: input.repository }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map((canWrite) => bitbucketViewerPermissions({ canWrite })),
      ),

    // `/diff` returns the whole patch without pagination.
    getDiff: (input) =>
      api
        .getPullRequestDiff({
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(
          Effect.mapError(fail("getDiff")),
          Effect.map((diff) => ({ ...diff, nextCursor: null })),
        ),

    getFileRevisions: (input) =>
      api
        .getFileRevisions({
          repository: input.repository,
          number: input.number,
          paths: input.paths,
        })
        .pipe(Effect.mapError(fail("getFileRevisions"))),

    // Bitbucket supports user reviewers only.
    listReviewerCandidates: (input) =>
      api
        .listReviewerCandidates({ repository: input.repository, number: input.number })
        .pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: (input) =>
      api
        .setReviewerRequest({
          repository: input.repository,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    runAction: (input) =>
      api
        .runAction({
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(
          Effect.mapError(fail("runAction")),
          Effect.map((pullRequest) => pullRequest && toActionSummary(pullRequest)),
        ),

    updateChangeRequest: (input) =>
      api
        .updateChangeRequest({
          repository: input.repository,
          number: input.number,
          title: input.title,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) =>
      api
        .comment({ repository: input.repository, number: input.number, body: input.body })
        .pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) =>
      api
        .updateComment({
          repository: input.repository,
          number: input.number,
          commentId: input.commentId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),

    submitReview: (input) =>
      api
        .submitReview({
          repository: input.repository,
          number: input.number,
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        })
        .pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      api
        .replyToComment({
          repository: input.repository,
          number: input.number,
          commentId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setReaction: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: SourceControlProviderKind.make("bitbucket"),
          operation: "setReaction",
          reason: "failed",
          detail: "Bitbucket does not support reactions.",
        }),
      ),

    setThreadResolution: (input) =>
      api
        .setCommentResolution({
          repository: input.repository,
          number: input.number,
          commentId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});

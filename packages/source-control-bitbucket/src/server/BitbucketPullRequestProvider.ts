import { resolvePullRequestAuthorFilter, SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
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
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
  // Bitbucket PR properties are shared, not per-reader viewed marks.
  viewedFiles: "environment",
};

const COMMIT_READ_CAPACITY = 256;
const COMMIT_READ_TTL = Duration.minutes(15);

const UNAVAILABLE_REQUIREMENT = {
  missing: "Bitbucket needs API credentials on the server. Add them in Settings → Source Control.",
  unauthenticated:
    "Bitbucket rejected the configured credentials. Check them in Settings → Source Control.",
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
  if (error._tag === "BitbucketResponseError" && error.status === 401) {
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
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

  const fail =
    (operation: string) => (error: BitbucketPullRequestApi.BitbucketPullRequestApiError) =>
      new PullRequestProviderError({
        provider: SourceControlProviderKind.make("bitbucket"),
        operation,
        ...bitbucketProviderFailure(error),
        detail: error.detail,
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

  // Null marks a conflicts read that failed and was recovered, so it is not held.
  const readCommitStats = (target: { readonly repository: string; readonly number: number }) =>
    Effect.all([api.getDiffStat(target), recoverRead(api.getMergeability(target), null)], {
      concurrency: 2,
    });

  // Diffstat and conflicts follow from the source and destination commits, so sync rereads them
  // when either moves. The expiry catches a destination branch that moved without the pull
  // request's destination commit following; a refresh or a finished turn drops them sooner.
  const commitStats = yield* Cache.makeWith(
    (key: string) => {
      const [repository, number] = JSON.parse(key) as [string, number, string, string];
      return readCommitStats({ repository, number });
    },
    {
      capacity: COMMIT_READ_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value[1] !== null ? COMMIT_READ_TTL : Duration.zero,
    },
  );

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("bitbucket"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    readsPublicHostWithoutCheckout: true,

    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          repository: input.repository,
          state: input.state,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          author:
            input.filters?.author === undefined
              ? undefined
              : resolvePullRequestAuthorFilter(input.filters.author, input.viewer),
          draft: input.filters?.draft === undefined ? undefined : input.filters.draft === "only",
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            continues: true,
          })),
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
          recoverRead(api.listChecks(target), []),
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
            checks,
            // Bitbucket exposes no strategy permissions; unsupported strategies fail at merge.
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            viewerPermissions: bitbucketViewerPermissions({ canWrite }),
          }),
        ),
      );
    },

    getChangeRequestSummary: (input) => {
      const target = { repository: input.repository, number: input.number };
      return api.getPullRequest(target).pipe(
        Effect.flatMap((pullRequest) =>
          (pullRequest.headSha === null || pullRequest.baseSha === null
            ? readCommitStats(target)
            : Cache.get(
                commitStats,
                JSON.stringify([
                  input.repository,
                  input.number,
                  pullRequest.headSha,
                  pullRequest.baseSha,
                ]),
              )
          ).pipe(
            Effect.map(([diffStat, mergeability]) => ({
              number: pullRequest.number,
              title: pullRequest.title,
              url: pullRequest.url,
              author: pullRequest.author,
              headBranch: pullRequest.headBranch,
              baseBranch: pullRequest.baseBranch,
              state: pullRequest.state,
              isDraft: pullRequest.isDraft,
              mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
              closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
              updatedAt: pullRequest.updatedAt,
              additions: diffStat.additions,
              deletions: diffStat.deletions,
              changedFiles: diffStat.changedFiles,
              mergeability: mergeability ?? "unknown",
            })),
          ),
        ),
        Effect.mapError(fail("getChangeRequestSummary")),
      );
    },

    forgetChangeRequestReads: (scope) =>
      scope === undefined
        ? Cache.invalidateAll(commitStats)
        : Cache.keys(commitStats).pipe(
            Effect.flatMap((keys) =>
              Effect.forEach(
                Array.from(keys).filter((key) => {
                  const [repository, number] = JSON.parse(key) as [string, number];
                  return (
                    repository.toLowerCase() === scope.repository.toLowerCase() &&
                    (scope.number === undefined || number === scope.number)
                  );
                }),
                (key) => Cache.invalidate(commitStats, key),
                { discard: true },
              ),
            ),
          ),

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
        .pipe(Effect.mapError(fail("runAction"))),

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

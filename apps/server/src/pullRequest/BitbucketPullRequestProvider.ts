import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { BitbucketPullRequest } from "./bitbucketPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  // Bitbucket has no endpoint that reopens a declined pull request, and nothing documented that
  // moves one in or out of draft, so neither is offered rather than failing when pressed.
  actions: ["merge", "close"],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  // Bitbucket Cloud's API exposes no reaction on a pull request or on a comment, so none is
  // read and none is offered.
  reactions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

/**
 * What the configured account may do here, from the one thing Bitbucket states per viewer: the
 * repository permission. Merging needs `write` or `admin`, so that is what narrows.
 *
 * Declining stays offered whatever the permission. Bitbucket lets the author of a pull request
 * decline their own with no more than read access, and the permission response says nothing about
 * who opened this one — so withholding the control from the one person entitled to it is the
 * worse of the two mistakes. Commenting and reviewing are not narrowed either: read access is
 * enough to say something, to approve and to ask for changes.
 *
 * Asking for a review is left open for the same reason: Bitbucket takes a reviewer set from the
 * author of a pull request as well as from whoever can write, and says nothing here about which
 * of the two this account is.
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

/** The failures that mean the credentials are the problem, rather than one request. */
export function bitbucketProviderFailure(
  error: BitbucketPullRequestApi.BitbucketPullRequestApiError,
): PullRequestProviderFailure {
  // Bitbucket is read over HTTP with credentials from the environment, so there is no tool to be
  // missing: unusable always means the credentials are absent or refused.
  if (error._tag === "BitbucketResponseError" && error.status === 401) {
    return { reason: "unauthenticated" };
  }
  if (error._tag === "BitbucketResponseError" && error.status === 429) {
    return {
      reason: "rate-limited",
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    };
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
    ...(pullRequest.headRepositoryNameWithOwner
      ? { headRepositoryNameWithOwner: pullRequest.headRepositoryNameWithOwner }
      : {}),
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    // Line counts are a separate read, which only the detail is worth spending on.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Bitbucket has no labels on a pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

  const fail =
    (operation: string) => (error: BitbucketPullRequestApi.BitbucketPullRequestApiError) =>
      new PullRequestProviderError({
        provider: "bitbucket",
        operation,
        ...bitbucketProviderFailure(error),
        // Every Bitbucket failure states its own fact; this names the operation around it, so
        // the two do not stack into "failed in x: failed in y: ...".
        detail: error.detail,
        cause: error,
      });

  const provider: PullRequestProviderApi = {
    kind: "bitbucket",
    capabilities: CAPABILITIES,

    // Bitbucket credentials come from the server's environment rather than a checkout, so the
    // account is the same whichever workspace asks.
    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          repository: input.repository,
          state: input.state,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            // Bitbucket is asked for `-updated_on` whether or not it is being carried on from,
            // so every page it answers is one a cursor can continue.
            continues: true,
          })),
        ),

    getChangeRequest: (input) => {
      const target = { repository: input.repository, number: input.number };
      return Effect.all(
        [
          api.getPullRequest(target),
          api.getDiffStat(target),
          api.getMergeability(target).pipe(Effect.orElseSucceed(() => "unknown" as const)),
          api.listChecks(target).pipe(Effect.orElseSucceed(() => [])),
          // A permission that could not be read is an unknown one, which is granted: a hidden
          // Merge leaves someone entitled to it with no way through, and one Bitbucket refuses
          // at least says why.
          api.getRepositoryPermission(target).pipe(Effect.orElseSucceed(() => true)),
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
            mergedAt: null,
            closedAt: null,
            reviewers: pullRequest.reviewers,
            checks,
            // Bitbucket publishes no per-repository list of allowed strategies, so the ones it
            // supports are all offered and a strategy the repository forbids fails on merge.
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
          // Reviews ride on the pull request itself, so this inexpensive core read is repeated
          // here rather than making the core response wait for the conversation endpoints.
          api.getPullRequest(target),
          api
            .listComments(target)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], threads: [], truncated: true }))),
          api.listCommits(target).pipe(Effect.orElseSucceed(() => [])),
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

    // `/diff` answers with the whole patch and pages nothing, so the first slice is the last.
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

    // Users only: Bitbucket requests a review of an account, and has no group that stands in for
    // one on a pull request.
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

    // Never called: `capabilities.reactions` is false, and the service refuses without it.
    setReaction: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "bitbucket",
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

import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition } from "../shared/definition.ts";
import * as BitbucketServerPullRequestApi from "./BitbucketServerPullRequestApi.ts";
import type { BitbucketServerPullRequest } from "./bitbucketServerPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  // Data Center's REST API carries no reaction on a pull request or a comment.
  reactions: false,
  // A thread's resolution is a field on its root comment, rewritten with that comment's version;
  // not offered until the page has a reason to want it.
  review: {
    inlineComment: true,
    reply: true,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

// Authors may decline with read access; only merging requires repository write permission.
export function bitbucketServerViewerPermissions(input: {
  readonly canWrite: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter((action) => action !== "merge" || input.canWrite),
    comment: true,
    resolve: false,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
  };
}

/** The failures that mean the token or the configuration is the problem, rather than one request. */
export function bitbucketServerProviderFailure(
  error: BitbucketServerPullRequestApi.BitbucketServerPullRequestApiError,
): PullRequestProviderFailure {
  // Data Center is read over HTTP with a configured token, so there is no tool to be missing:
  // unusable always means the token is absent or refused.
  if (error._tag === "SourceControlRateLimitPausedError")
    return { reason: "rate-limited", retryAt: error.retryAt };
  if (error._tag === "BitbucketServerNotConfiguredError") return { reason: "unauthenticated" };
  if (error._tag === "BitbucketServerViewerUnavailableError") {
    return { reason: error.reason === "unauthenticated" ? "unauthenticated" : "failed" };
  }
  if (error._tag === "BitbucketServerResponseError" && error.status === 401) {
    return { reason: "unauthenticated" };
  }
  if (error._tag === "BitbucketServerResponseError" && error.status === 429) {
    return {
      reason: "rate-limited",
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    };
  }
  if (error._tag === "BitbucketServerResponseError" && error.status === 404) {
    return { reason: "not-found" };
  }
  return { reason: "failed" };
}

function toChangeRequest(pullRequest: BitbucketServerPullRequest): ProviderChangeRequest {
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
    // The host states no conflict on a listing; the detail asks its merge check, which does.
    mergeability: "unknown",
    // The host states no line counts anywhere short of the patch itself, which is not worth
    // downloading twice for two numbers.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    closedAt: pullRequest.closedAt,
    ...(pullRequest.state === "merged" ? { mergedAt: pullRequest.closedAt } : {}),
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Data Center has no labels on a pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;

  const fail =
    (operation: string) =>
    (error: BitbucketServerPullRequestApi.BitbucketServerPullRequestApiError) =>
      new PullRequestProviderError({
        provider: definition.kind,
        operation,
        ...bitbucketServerProviderFailure(error),
        detail: error.detail,
        cause: error,
      });

  // Only reached if a caller ignores the capabilities above; the service refuses first.
  const unsupported = (operation: string, detail: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: definition.kind,
        operation,
        reason: "failed",
        detail,
      }),
    );

  const recoverRead =
    <A>(fallback: A) =>
    <B>(read: Effect.Effect<B, BitbucketServerPullRequestApi.BitbucketServerPullRequestApiError>) =>
      read.pipe(
        Effect.catchIf(
          (error) => bitbucketServerProviderFailure(error).reason !== "rate-limited",
          () => Effect.succeed(fallback),
        ),
      );

  const provider = {
    kind: definition.kind,
    capabilities: CAPABILITIES,

    // The token is configured on the server rather than per checkout, so the account is the
    // same whichever workspace asks.
    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            cursorAdvance: batch.cursorAdvance,
            resumeAfter: batch.resumeAfter,
            // The host answers in one order (newest created first) whether or not it is being
            // carried on from, so a slice can always be stepped past — by counting, which is
            // what it pages by.
            continues: true,
          })),
        ),

    getChangeRequestSummary: (input) =>
      api.getPullRequest(input).pipe(
        Effect.mapError(fail("getChangeRequestSummary")),
        Effect.map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          state: pr.state,
          isDraft: pr.isDraft,
          updatedAt: pr.updatedAt,
          closedAt: pr.state === "closed" ? pr.closedAt : null,
          mergedAt: pr.state === "merged" ? pr.closedAt : null,
        })),
      ),
    getChangeRequestPreview: (input) =>
      api.getPullRequest(input).pipe(
        Effect.mapError(fail("getChangeRequestPreview")),
        Effect.map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          state: pr.state,
          isDraft: pr.isDraft,
          createdAt: pr.createdAt,
        })),
      ),
    getChangeRequestChecks: (input) =>
      api.getPullRequest({ repository: input.repository, number: input.number }).pipe(
        Effect.flatMap((pullRequest) =>
          (pullRequest.headCommit === null
            ? Effect.succeed([])
            : api.listChecks({ repository: input.repository, commit: pullRequest.headCommit })
          ).pipe(Effect.map((checks) => ({ state: pullRequest.state, checks }))),
        ),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    getChangeRequest: (input) => {
      const target = { repository: input.repository, number: input.number };
      return api.getPullRequest(target).pipe(
        Effect.flatMap((pullRequest) =>
          Effect.all(
            [
              api.getMergeability(target).pipe(recoverRead("unknown" as const)),
              pullRequest.headCommit === null
                ? Effect.succeed([])
                : api
                    .listChecks({ repository: input.repository, commit: pullRequest.headCommit })
                    .pipe(recoverRead([])),
              api.getChangedFileCount(target).pipe(recoverRead(0)),
              // A permission that could not be read is an unknown one, which is granted: a
              // hidden Merge leaves someone entitled to it with no way through, and one the host
              // refuses at least says why.
              api.getRepositoryPermission(target).pipe(recoverRead(true)),
            ],
            { concurrency: 4 },
          ).pipe(
            Effect.map(
              ([mergeability, checks, changedFiles, canWrite]): ProviderChangeRequestDetail => ({
                ...toChangeRequest(pullRequest),
                ...(pullRequest.headCommit === null ? {} : { headSha: pullRequest.headCommit }),
                mergeability,
                changedFiles,
                body: pullRequest.body,
                mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
                closedAt: pullRequest.closedAt,
                reviewers: pullRequest.reviewers,
                checks,
                // The host publishes no per-repository list of allowed strategies, so the three
                // it supports are all offered and one the repository forbids fails on merge.
                mergeCapabilities: { merge: true, squash: true, rebase: true },
                viewerPermissions: bitbucketServerViewerPermissions({ canWrite }),
              }),
            ),
          ),
        ),
        Effect.mapError(fail("getChangeRequest")),
      );
    },

    getChangeRequestActivity: (input) => {
      const target = { repository: input.repository, number: input.number };
      return api.getPullRequest(target).pipe(
        Effect.flatMap((pullRequest) =>
          Effect.all(
            [
              api
                .listActivities({ ...target, pullRequestUrl: pullRequest.url })
                .pipe(recoverRead({ comments: [], threads: [], truncated: true })),
              api.listCommits(target).pipe(recoverRead([])),
            ],
            { concurrency: 2 },
          ),
        ),
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([activity, commits]): ProviderChangeRequestActivity => ({
          comments: activity.comments,
          commentCount: activity.comments.length,
          commentsTruncated: activity.truncated,
          reviewThreads: activity.threads,
          commits,
        })),
      );
    },

    getViewerPermissions: (input) =>
      api.getRepositoryPermission({ repository: input.repository }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map((canWrite) => bitbucketServerViewerPermissions({ canWrite })),
      ),

    // `.diff` answers with the whole patch and pages nothing, so the first slice is the last.
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

    getDiffFileContents: (input) =>
      api
        .getDiffFileContents({
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
          changeType: input.changeType,
          oldPath: input.oldPath,
          newPath: input.newPath,
        })
        .pipe(Effect.mapError(fail("getDiffFileContents"))),

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

    // Data Center keeps a pull request's remarks and its line comments in the one collection,
    // so either kind is rewritten the same way.
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

    // Users only: Data Center asks a review of an account, and has no group that stands in for
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

    // A thread's id is its root comment's, which is what a reply names as its parent.
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
      unsupported("setReaction", "Bitbucket Data Center does not support reactions."),
    setThreadResolution: () =>
      unsupported(
        "setThreadResolution",
        "Bitbucket Data Center threads are not resolved from here.",
      ),
  } satisfies PullRequestProviderApi;

  const onHost =
    <I extends { readonly host?: string }, A, E, R>(run: (input: I) => Effect.Effect<A, E, R>) =>
    (input: I) =>
      run(input).pipe(Effect.provideService(BitbucketServerApi.ExpectedHost, input.host ?? null));
  return {
    ...provider,
    getViewer: onHost(provider.getViewer),
    listChangeRequests: onHost(provider.listChangeRequests),
    getChangeRequestSummary: onHost(provider.getChangeRequestSummary),
    getChangeRequestPreview: onHost(provider.getChangeRequestPreview),
    getChangeRequestChecks: onHost(provider.getChangeRequestChecks),
    getChangeRequest: onHost(provider.getChangeRequest),
    getChangeRequestActivity: onHost(provider.getChangeRequestActivity),
    getViewerPermissions: onHost(provider.getViewerPermissions),
    getDiff: onHost(provider.getDiff),
    runAction: onHost(provider.runAction),
    comment: onHost(provider.comment),
    submitReview: onHost(provider.submitReview),
    listReviewerCandidates: onHost(provider.listReviewerCandidates),
    setReviewerRequest: onHost(provider.setReviewerRequest),
    replyToThread: onHost(provider.replyToThread),
    setReaction: onHost(provider.setReaction),
    setThreadResolution: onHost(provider.setThreadResolution),
    getDiffFileContents: onHost(provider.getDiffFileContents),
    updateChangeRequest: onHost(provider.updateChangeRequest),
    updateComment: onHost(provider.updateComment),
  };
});

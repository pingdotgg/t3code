import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "ready", "draft", "close", "reopen"],
  // GitLab offers all three, though a project settles on one; `mergeCapabilities` narrows it.
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // No "changes requested": GitLab has approval and unresolved discussions, and nothing that
    // says a merge request has been reviewed and rejected.
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: true, listCandidates: true },
};

/**
 * What the signed-in account may do here. GitLab answers exactly one of these questions per
 * viewer, on the merge request itself: `user.can_merge`, which is why merging is the only thing
 * narrowed.
 *
 * The rest stay granted. GitLab's REST API reports the viewer's role on the project but never
 * whether they opened this merge request — and its author may close it, reopen it and move it in
 * and out of draft whatever their role, just as the author of a note may resolve the discussion
 * it started. Withholding those controls from the one person entitled to them is the worse of the
 * two mistakes, so they are offered and GitLab explains any refusal itself.
 *
 * Asking for a review is granted for the same reason: GitLab takes a reviewer set from the author
 * and from anyone with the Developer role, and states neither of those two facts here.
 */
export function gitLabViewerPermissions(input: {
  readonly viewerCanMerge: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter((action) => action !== "merge" || input.viewerCanMerge),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
  };
}

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderError["reason"] {
  if (error._tag === "GitLabCliUnavailableError") return "missing-tool";
  if (error._tag === "GitLabCliAuthenticationError") return "unauthenticated";
  return "failed";
}

export const make = Effect.gen(function* () {
  const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

  const fail = (operation: string) => (error: GitLabPullRequestCli.GitLabPullRequestCliError) =>
    new PullRequestProviderError({
      provider: "gitlab",
      operation,
      reason: reasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "gitlab",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerUsername({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listMergeRequests({
          cwd: input.cwd,
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
          // GitLab is asked for its merge requests by update, newest first, whether or not it is
          // being carried on from — so every page it answers is one a cursor can continue.
          Effect.map((batch) => ({ ...batch, continues: true })),
        ),

    getChangeRequest: (input) =>
      Effect.all(
        [
          cli.getMergeRequestDetail(input),
          cli.getProjectMergeCapabilities({ cwd: input.cwd, repository: input.repository }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([mergeRequest, mergeCapabilities]): ProviderChangeRequestDetail => ({
            ...mergeRequest,
            mergeCapabilities,
            viewerPermissions: gitLabViewerPermissions(mergeRequest),
          }),
        ),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          cli
            .listNotes(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: true }))),
          cli.listCommits(input).pipe(Effect.orElseSucceed(() => [])),
          cli
            .listDiscussions(input)
            .pipe(Effect.orElseSucceed(() => ({ threads: [], truncated: true }))),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([notes, commits, discussions]): ProviderChangeRequestActivity => ({
            comments: notes.comments,
            // GitLab reports no count of its own, so the walk's own total is the host's: the
            // notes endpoint carries every comment on the merge request, including the ones
            // written under a discussion, and it is read until GitLab runs out.
            commentCount: notes.comments.length,
            commentsTruncated: notes.truncated || discussions.truncated,
            reviewThreads: discussions.threads,
            commits,
          }),
        ),
      ),

    // The same read the detail takes it from, on its own: `user.can_merge` lives on the merge
    // request, so there is no cheaper thing to ask GitLab.
    getViewerPermissions: (input) =>
      cli
        .getMergeRequestDetail(input)
        .pipe(Effect.mapError(fail("getViewerPermissions")), Effect.map(gitLabViewerPermissions)),

    getDiff: (input) => cli.getMergeRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    // Users only: GitLab requests a review of a person, and the groups that can stand in for one
    // appear in approval rules rather than in a merge request's reviewers.
    listReviewerCandidates: (input) =>
      cli
        .listReviewerCandidates({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: (input) =>
      cli
        .setReviewerRequest({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    runAction: (input) =>
      cli
        .runMergeRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnMergeRequest(input).pipe(Effect.mapError(fail("comment"))),

    submitReview: (input) => cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      cli
        .replyToDiscussion({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setThreadResolution: (input) =>
      cli
        .setDiscussionResolution({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});

import { NATIVE_ATTACHMENT_CAPABILITY } from "./PullRequestAttachments.ts";
import * as Effect from "effect/Effect";
import type {
  PullRequestCapabilities,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  attachments: {
    ...NATIVE_ATTACHMENT_CAPABILITY,
    reason: "Requires glab 1.91 or later. The GitLab server may set a smaller file limit.",
  },
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  // GitLab offers all three, though a project settles on one; `mergeCapabilities` narrows it.
  mergeMethods: ["merge", "squash", "rebase"],
  // Rebase alone: GitLab moves a stale branch onto its target by replaying it, and has nothing
  // that merges the target back in the way GitHub's update button can. Declaring only what it
  // does is what lets a request to merge the target in be refused instead of quietly rebasing.
  updateMethods: ["rebase"],
  search: true,
  reactions: true,
  // GitLab keeps a reader's viewed files in one browser's local storage, where nothing outside
  // that browser can read or write them. So the marks made here are this environment's own: they
  // follow the reader between the clients connected to it, but they are not the ones gitlab.com
  // shows, and the surface says so rather than implying a review can be carried on from there.
  viewedFiles: "environment",
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
 * The actions `user.can_merge` answers for. Rebasing writes to the source branch rather than to
 * the target, so it is not literally the same permission — but GitLab reports nothing narrower,
 * and someone it will not let land this change has no business rewriting its branch either.
 */
const MERGE_ACTIONS: ReadonlySet<string> = new Set([
  "merge",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
]);

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
  readonly canRequestChanges?: boolean;
}): PullRequestViewerPermissions {
  return {
    // Arming the merge and taking the arming back are the merge, deferred, so they answer to
    // the same `can_merge` the merge itself does.
    actions: CAPABILITIES.actions.filter(
      (action) => !MERGE_ACTIONS.has(action) || input.viewerCanMerge,
    ),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts.filter(
      (verdict) => verdict !== "request-changes" || input.canRequestChanges === true,
    ),
    requestReviewers: true,
    ...(input.viewerCanMerge ? { updateMethods: CAPABILITIES.updateMethods } : {}),
  };
}

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
export function gitLabProviderFailure(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "GitLabCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitLabCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitLabCliRateLimitError") return { reason: "rate-limited" };
  return { reason: "failed" };
}

function commentUrl(input: { host: string; repository: string; number: number }, id: string) {
  const repository = input.repository.split("/").map(encodeURIComponent).join("/");
  return `https://${input.host}/${repository}/-/merge_requests/${input.number}#note_${id}`;
}

export const make = Effect.gen(function* () {
  const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

  const fail = (operation: string) => (error: GitLabPullRequestCli.GitLabPullRequestCliError) =>
    new PullRequestProviderError({
      provider: "gitlab",
      operation,
      ...gitLabProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "gitlab",
    capabilities: CAPABILITIES,
    getCapabilities: (input) =>
      cli.getRequestChangesViewer(input).pipe(
        Effect.mapError(fail("getCapabilities")),
        Effect.map((viewer) => ({
          ...CAPABILITIES,
          review: {
            ...CAPABILITIES.review,
            verdicts: CAPABILITIES.review.verdicts.filter(
              (verdict) => verdict !== "request-changes" || viewer !== null,
            ),
          },
        })),
      ),

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
          cli.getRequestChangesViewer(input),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(([mergeRequest, mergeCapabilities, viewer]): ProviderChangeRequestDetail => ({
          ...mergeRequest,
          mergeCapabilities,
          viewerPermissions: gitLabViewerPermissions({
            ...mergeRequest,
            canRequestChanges:
              viewer !== null &&
              mergeRequest.reviewers.some((reviewer) => reviewer.login === viewer),
          }),
          // A GitLab too old to count the divergence says nothing here rather than "up to
          // date": the banner is worth missing, and a wrong all-clear is not worth showing.
          baseComparison:
            mergeRequest.divergedCommits === undefined
              ? "unknown"
              : mergeRequest.divergedCommits > 0
                ? "behind"
                : "up-to-date",
          ...(mergeRequest.divergedCommits === undefined
            ? {}
            : { behindBy: mergeRequest.divergedCommits }),
        })),
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
          // The notes endpoint carries no award of any kind, so they are read alongside it. A
          // failed read costs the conversation its reactions rather than its words.
          cli.listReactions(input).pipe(
            Effect.orElseSucceed(() => ({
              reactions: [] as ReadonlyArray<PullRequestReaction>,
              reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
            })),
          ),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([notes, commits, discussions, awards]): ProviderChangeRequestActivity => {
          const comments = new Map(notes.comments.map((comment) => [comment.id, comment]));
          for (const thread of discussions.threads) {
            for (const comment of thread.comments) {
              comments.set(comment.id, {
                ...comment,
                kind: thread.path === null ? "issue-comment" : "review-comment",
                path: thread.path,
                reviewState: null,
              });
            }
          }
          return {
            reactions: awards.reactions,
            comments: [...comments.values()]
              .map((comment) => ({
                ...comment,
                url: commentUrl(input, comment.id),
                reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
              }))
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            commentCount: comments.size,
            commentsTruncated: notes.truncated || discussions.truncated,
            reviewThreads: discussions.threads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                url: commentUrl(input, comment.id),
                reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
              })),
            })),
            commits,
          };
        }),
      ),

    // The same read the detail takes it from, on its own: `user.can_merge` lives on the merge
    // request, so there is no cheaper thing to ask GitLab.
    getViewerPermissions: (input) =>
      Effect.all([cli.getMergeRequestDetail(input), cli.getRequestChangesViewer(input)], {
        concurrency: 2,
      }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map(([detail, viewer]) =>
          gitLabViewerPermissions({
            ...detail,
            canRequestChanges:
              viewer !== null && detail.reviewers.some((reviewer) => reviewer.login === viewer),
          }),
        ),
      ),

    getDiff: (input) => cli.getMergeRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    // What each marked file is at the head, which is what tells a mark that still stands from one
    // the branch has moved past. GitLab's own local-storage marks are keyed on the blob id too,
    // so this stales at the same moment its web UI would.
    getFileRevisions: (input) =>
      cli.getFileRevisions(input).pipe(
        Effect.mapError(fail("getFileRevisions")),
        Effect.map((revisions) => ({ revisions })),
      ),

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

    updateChangeRequest: (input) =>
      cli
        .updateMergeRequest({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) => cli.commentOnMergeRequest(input).pipe(Effect.mapError(fail("comment"))),

    uploadAttachment: (input) => cli.uploadAttachment(input),
    ...(cli.readAttachment ? { readAttachment: cli.readAttachment } : {}),
    updateComment: (input) =>
      cli
        .updateNote({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          noteId: input.commentId,
          ...(input.threadId === undefined ? {} : { discussionId: input.threadId }),
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),

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

    setReaction: (input) =>
      cli
        .setReaction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { noteId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(Effect.mapError(fail("setReaction"))),

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

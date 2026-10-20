import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewThread,
  PullRequestReviewCommentDraft,
} from "@t3tools/contracts";

/** A resolved thread's compact label uses the host's total and distinct participant names. */
export function resolvedReviewCommentsLabel(count: number, participants: ReadonlyArray<string>) {
  const names = [...new Set(participants)].join(" and ");
  return `${count} resolved ${count === 1 ? "comment" : "comments"}${names ? ` from ${names}` : ""}`;
}

/** Read private host drafts without replacing the identity of a locally saved draft. */
export function pendingReviewCommentsFromThreads(threads: ReadonlyArray<PullRequestReviewThread>) {
  return threads.flatMap((thread) => {
    const line = thread.line;
    if (line === null) return [];
    return thread.comments.flatMap(
      (comment): (PullRequestReviewCommentDraft & { id: string })[] => {
        if (!comment.pendingReviewId || !comment.url) return [];
        return [
          {
            id: comment.id,
            path: thread.path,
            position:
              thread.side === "left"
                ? {
                    kind: "deleted",
                    oldLine: line,
                    startLine: thread.startLine,
                    startSide: thread.startSide,
                  }
                : {
                    kind: "added",
                    newLine: line,
                    startLine: thread.startLine,
                    startSide: thread.startSide,
                  },
            body: comment.body,
            hostedComment: {
              reviewId: comment.pendingReviewId,
              commentId: comment.id,
              url: comment.url,
            },
          },
        ];
      },
    );
  });
}

/** Only the parts of a detail either answer reads, so a caller can pass a whole detail view. */
type EditingSubject = Pick<
  PullRequestDetail,
  "author" | "capabilities" | "viewer" | "viewerPermissions"
>;

function sameLogin(one: string | null | undefined, other: string | null | undefined): boolean {
  if (one == null || other == null) return false;
  return one.trim().toLowerCase() === other.trim().toLowerCase();
}

export function canEditPullRequestChangeRequest(detail: EditingSubject): boolean {
  if (detail.capabilities.edit?.changeRequest !== true) return false;
  if (detail.viewerPermissions.editChangeRequest !== undefined) {
    return detail.viewerPermissions.editChangeRequest;
  }
  return (
    sameLogin(detail.viewer, detail.author?.login) ||
    detail.viewerPermissions.actions.includes("merge")
  );
}

/**
 * A review's own summary is left out: the hosts disagree about what one even is, and none of
 * them takes a rewrite of it through the mutation a comment goes through.
 */
export function canEditPullRequestComment(
  detail: EditingSubject,
  comment: Pick<PullRequestComment, "author" | "canEdit" | "kind">,
): boolean {
  if (detail.capabilities.edit?.comment !== true) return false;
  if (comment.kind !== "issue-comment" && comment.kind !== "review-comment") return false;
  if (comment.canEdit !== undefined) return comment.canEdit;
  return sameLogin(detail.viewer, comment.author?.login);
}

export function canResolvePullRequestThread(
  detail: Pick<PullRequestDetail, "viewerPermissions">,
  thread: Pick<PullRequestReviewThread, "canResolve">,
): boolean {
  return detail.viewerPermissions.resolve && thread.canResolve !== false;
}

/** A reply to a private thread must stay in the same pending review. */
export function reviewThreadReplyTarget(thread: PullRequestReviewThread) {
  const pendingReviewId = thread.comments.find(
    (comment) => comment.pendingReviewId,
  )?.pendingReviewId;
  return { threadId: thread.id, ...(pendingReviewId ? { pendingReviewId } : {}) };
}

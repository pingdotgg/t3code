import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewThread,
} from "@t3tools/contracts";

/** Only the parts of a detail either answer reads, so a caller can pass a whole detail view. */
type EditingSubject = Pick<
  PullRequestDetail,
  "author" | "capabilities" | "viewer" | "viewerPermissions"
>;

/** Hosts disagree about the case of a login and none of them treats two casings as two people. */
function sameLogin(one: string | null | undefined, other: string | null | undefined): boolean {
  if (one == null || other == null) return false;
  return one.trim().toLowerCase() === other.trim().toLowerCase();
}

/**
 * Whether the title and description can be rewritten from here. Beyond the host being able to at
 * all, a host that reports `editChangeRequest` answers directly. Otherwise either the reader wrote
 * the change request or they may merge it: merging is the one action every host here grants with
 * write access and withholds without it, so it stands in for the permission they don't publish.
 */
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
 * Whether this remark can be rewritten from here. A review's own summary is left out: the hosts
 * disagree about what one even is, and none of them takes a rewrite of it through the mutation
 * a comment goes through.
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

/**
 * Whether the reader may resolve or reopen one review thread. The host's answer for this thread
 * can only narrow the reader's repository-wide `resolve` permission: a thread can't grant what the
 * repository withholds.
 */
export function canResolvePullRequestThread(
  detail: Pick<PullRequestDetail, "viewerPermissions">,
  thread: Pick<PullRequestReviewThread, "canResolve">,
): boolean {
  return detail.viewerPermissions.resolve && thread.canResolve !== false;
}

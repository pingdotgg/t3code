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
        const start = thread.startLine;
        return [
          {
            id: comment.id,
            path: thread.path,
            position:
              thread.side === "left"
                ? { kind: "deleted", oldLine: line }
                : { kind: "added", newLine: line },
            ...(start === undefined
              ? {}
              : {
                  startPosition:
                    (thread.startSide ?? thread.side) === "left"
                      ? { kind: "deleted" as const, oldLine: start }
                      : { kind: "added" as const, newLine: start },
                }),
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

/** Existing private comments retain their identity after their diff lines become outdated. */
export function pendingReviewIdentityFromThreads(
  threads: ReadonlyArray<PullRequestReviewThread>,
  removedIds: ReadonlyArray<string> = [],
) {
  const removed = new Set(removedIds);
  const comments = threads.flatMap((thread) =>
    thread.comments
      .filter((comment) => comment.pendingReviewId && !removed.has(comment.id))
      .map((comment) => ({ comment, outdated: thread.line === null })),
  );
  return {
    pendingReviewId: comments[0]?.comment.pendingReviewId,
    outdatedComments: comments
      .filter((entry) => entry.outdated)
      .map(({ comment }) => ({ id: comment.id, body: comment.body })),
  };
}

export function groupPendingReviewComments<T extends PullRequestReviewCommentDraft>(
  threads: ReadonlyArray<PullRequestReviewThread>,
  pendingComments: ReadonlyArray<T>,
) {
  const pendingIds = new Set(
    pendingComments.flatMap((comment) =>
      comment.hostedComment ? [comment.hostedComment.commentId] : [],
    ),
  );
  const represented = new Set<string>();
  const conversations = threads.flatMap((thread) => {
    const comments = thread.comments.filter(
      (comment) => !comment.pendingReviewId || thread.line === null || pendingIds.has(comment.id),
    );
    if (comments.length === 0) return [];
    for (const comment of comments) represented.add(comment.id);
    return [
      comments.length === thread.comments.length
        ? thread
        : {
            ...thread,
            comments,
            ...(thread.commentCount === undefined
              ? {}
              : {
                  commentCount: Math.max(
                    comments.length,
                    thread.commentCount - (thread.comments.length - comments.length),
                  ),
                }),
          },
    ];
  });
  return {
    threads: conversations,
    pendingComments: pendingComments.filter(
      (comment) => !comment.hostedComment || !represented.has(comment.hostedComment.commentId),
    ),
  };
}

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

export function canEditPullRequestMaintainerEdits(
  detail: Pick<
    PullRequestDetail,
    "state" | "capabilities" | "viewerPermissions" | "maintainerCanModify"
  >,
): boolean {
  return (
    detail.state === "open" &&
    detail.capabilities.edit?.maintainerEdits === true &&
    detail.viewerPermissions.maintainerEdits === true &&
    detail.maintainerCanModify !== undefined
  );
}

export interface MaintainerEditsChoice {
  readonly key: string;
  readonly observedAt: number | undefined;
  readonly value: boolean;
}

/**
 * A saved choice ends at the first host reading delivered after the save. Readers refresh once it
 * succeeds, which drops reads still in flight, so that reading started after the write.
 */
export function maintainerEditsChoiceInForce<
  Choice extends { readonly key: string; readonly observedAt: number | undefined },
>(
  choice: Choice | null,
  key: string,
  observedAt: number | undefined,
  saving: boolean,
): Choice | null {
  if (choice === null || choice.key !== key) return null;
  if (saving) return choice.observedAt === observedAt ? choice : { ...choice, observedAt };
  return observedAt !== undefined && choice.observedAt === observedAt ? choice : null;
}

/** A description written from this client, shown in place of the host's copy. */
export interface DescriptionDraft {
  readonly key: string;
  readonly observedAt: number | undefined;
  /** Null once the last save failed: until a host reading, nobody knows which saves landed. */
  readonly body: string | null;
  /** Saves still running. The host applies them in order, so the last one is `body`. */
  readonly saves: number;
}

/** Same lifetime as a maintainer edits choice: until the first host reading after the saves. */
export function descriptionDraftInForce(
  draft: DescriptionDraft | null,
  key: string,
  observedAt: number | undefined,
): DescriptionDraft | null {
  return maintainerEditsChoiceInForce(draft, key, observedAt, (draft?.saves ?? 0) > 0);
}

export function startDescriptionSave(
  draft: DescriptionDraft | null,
  detail: { readonly url: string; readonly observedAt?: number | undefined },
  body: string,
): DescriptionDraft {
  const saves = draft?.key === detail.url ? draft.saves : 0;
  return { key: detail.url, observedAt: detail.observedAt, body, saves: saves + 1 };
}

/** Each save writes the whole body, so a failure only loses `body` when no later save is running. */
export function settleDescriptionSave(
  draft: DescriptionDraft | null,
  key: string,
  saved: boolean,
): DescriptionDraft | null {
  if (draft === null || draft.key !== key || draft.saves === 0) return draft;
  const saves = draft.saves - 1;
  return { ...draft, saves, body: saved || saves > 0 ? draft.body : null };
}

/** Hosts do not support rewriting review summaries through comment mutations. */
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

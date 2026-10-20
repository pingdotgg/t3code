/**
 * A review being written, held until it is sent.
 *
 * New comments save to the host's private pending review and retain their identity for later
 * discard or submission. Local drafts remain available if saving fails. Host
 * drafts are also read back from the detail, so reloading keeps saved pending comments.
 */
import { pendingReviewCommentsFromThreads } from "@t3tools/client-runtime/review-editing";
import type {
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { create } from "zustand";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };

/**
 * A counter rather than anything derived from the comment: two remarks on one line can be the
 * same length, and an id built from the draft's own contents would collide with a comment that
 * was already removed — which shares a React key with it and, worse, makes discarding one card
 * delete both.
 */
let pendingCommentSequence = 0;

export function nextPendingReviewCommentId(): string {
  pendingCommentSequence += 1;
  return `pending-review-comment-${pendingCommentSequence}`;
}

export function pullRequestReviewKey(reference: PullRequestRef): string {
  return JSON.stringify([
    reference.projectId,
    reference.host?.toLowerCase() ?? null,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

interface PullRequestReviewStoreState {
  readonly drafts: Readonly<Record<string, ReadonlyArray<PendingReviewComment>>>;
  readonly removedHostComments: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly busyComments: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly setCommentBusy: (key: string, id: string, busy: boolean) => void;
  readonly setHostedComment: (
    key: string,
    id: string,
    hosted: NonNullable<PendingReviewComment["hostedComment"]>,
  ) => void;
  readonly summaries: Readonly<Record<string, string>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (
    key: string,
    commentIds: ReadonlyArray<string>,
    hostedIds?: ReadonlyArray<string>,
  ) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  drafts: {},
  removedHostComments: {},
  busyComments: {},
  setCommentBusy: (key, id, busy) =>
    set((state) => {
      const previous = state.busyComments[key] ?? [];
      return {
        busyComments: {
          ...state.busyComments,
          [key]: busy ? [...new Set([...previous, id])] : previous.filter((entry) => entry !== id),
        },
      };
    }),
  setHostedComment: (key, id, hostedComment) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: (state.drafts[key] ?? []).map((comment) =>
          comment.id === id ? { ...comment, hostedComment } : comment,
        ),
      },
    })),
  summaries: {},
  addComment: (key, comment) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
    })),
  removeComment: (key, commentId) =>
    usePullRequestReviewStore.getState().removeComments(key, [commentId]),
  removeComments: (key, commentIds, hostedIds = []) =>
    set((state) => {
      const submitted = new Set(commentIds);
      const previous = state.drafts[key] ?? EMPTY;
      const remaining = previous.filter((entry) => !submitted.has(entry.id));
      // A refresh can still contain the old host snapshot after a successful mutation.
      // Remember host identities so that snapshot cannot resurrect the removed cards.
      const removedHostComments = {
        ...state.removedHostComments,
        [key]: [
          ...new Set([
            ...(state.removedHostComments[key] ?? []),
            ...hostedIds,
            ...previous.flatMap((entry) =>
              submitted.has(entry.id) && entry.hostedComment ? [entry.hostedComment.commentId] : [],
            ),
          ]),
        ],
      };
      if (remaining.length > 0)
        return { drafts: { ...state.drafts, [key]: remaining }, removedHostComments };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest, removedHostComments };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  setSummary: (key, body) => set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
  clearSummary: (key, submittedBody) =>
    set((state) => {
      // The textarea stays editable while the request is in flight. Only remove the exact draft
      // the host accepted; a revised summary for the same pull request is new work.
      if (state.summaries[key] !== submittedBody) return state;
      const { [key]: _removed, ...rest } = state.summaries;
      return { summaries: rest };
    }),
}));

/** Save once per local comment, keeping unsaved text available for retry after a failed request. */
export async function savePendingReviewComment(
  key: string,
  given: PendingReviewComment,
  save: (
    comment: PendingReviewComment,
  ) => Promise<NonNullable<PendingReviewComment["hostedComment"]>>,
) {
  const store = usePullRequestReviewStore.getState();
  const comment = store.drafts[key]?.find((entry) => entry.id === given.id) ?? given;
  if (comment.hostedComment) return comment.hostedComment;
  if (store.busyComments[key]?.includes(comment.id)) return null;
  store.setCommentBusy(key, comment.id, true);
  try {
    const hosted = await save(comment);
    store.setHostedComment(key, comment.id, hosted);
    return hosted;
  } finally {
    store.setCommentBusy(key, comment.id, false);
  }
}

/** The comments a pull request's draft holds, stable across renders while it is empty. */
export function usePendingReviewComments(
  reference: PullRequestRef,
  threads?: ReadonlyArray<PullRequestReviewThread>,
): ReadonlyArray<PendingReviewComment> {
  const key = pullRequestReviewKey(reference);
  const local = usePullRequestReviewStore((store) => store.drafts[key] ?? EMPTY);
  const removedIds = usePullRequestReviewStore((store) => store.removedHostComments[key]);
  return mergePendingReviewComments(local, threads ?? [], removedIds ?? []);
}

/** Reconcile a cached host snapshot with successful local removals and published comments. */
export function mergePendingReviewComments(
  local: ReadonlyArray<PendingReviewComment>,
  threads: ReadonlyArray<PullRequestReviewThread>,
  removedIds: ReadonlyArray<string>,
): ReadonlyArray<PendingReviewComment> {
  const retired = new Set(removedIds);
  for (const thread of threads ?? []) {
    for (const comment of thread.comments) {
      if (!comment.pendingReviewId) retired.add(comment.id);
    }
  }
  const remaining = local.filter(
    (comment) => !comment.hostedComment || !retired.has(comment.hostedComment.commentId),
  );
  const localHostIds = new Set(remaining.map((comment) => comment.hostedComment?.commentId));
  const remote = pendingReviewCommentsFromThreads(threads ?? []).filter(
    (comment) => !retired.has(comment.id) && !localHostIds.has(comment.id),
  );
  return remote.length ? [...remaining, ...remote] : remaining;
}

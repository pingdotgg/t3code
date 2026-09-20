/**
 * A review being written, held until it is sent.
 *
 * Nothing here reaches the host: a review is one request carrying every line comment and the
 * verdict together, so a half-written one is invisible to everyone else — including on the
 * hosts that have no pending review of their own. That also means a draft lives only as long
 * as the tab does, which is why this is deliberately not persisted.
 */
import type { PullRequestRef, PullRequestReviewCommentDraft } from "@t3tools/contracts";
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

/** A project's thread can review the same repository path and number on different hosts. */
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
  readonly summaries: Readonly<Record<string, string>>;
  readonly submittingReviews: Readonly<Record<string, boolean>>;
  readonly setReviewSubmitting: (key: string, submitting: boolean) => void;
  readonly editingComments: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly setCommentEditing: (key: string, commentId: string, editing: boolean) => void;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly updateComment: (key: string, commentId: string, body: string) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (key: string, comments: ReadonlyArray<PendingReviewComment>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  drafts: {},
  summaries: {},
  submittingReviews: {},
  setReviewSubmitting: (key, submitting) =>
    set((state) => {
      if (submitting) return { submittingReviews: { ...state.submittingReviews, [key]: true } };
      const { [key]: _removed, ...rest } = state.submittingReviews;
      return { submittingReviews: rest };
    }),
  editingComments: {},
  setCommentEditing: (key, commentId, editing) =>
    set((state) => {
      const current = state.editingComments[key] ?? [];
      if (current.includes(commentId) === editing) return state;
      const next = editing ? [...current, commentId] : current.filter((id) => id !== commentId);
      if (next.length > 0) return { editingComments: { ...state.editingComments, [key]: next } };
      const { [key]: _removed, ...rest } = state.editingComments;
      return { editingComments: rest };
    }),
  addComment: (key, comment) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
    })),
  updateComment: (key, commentId, body) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: (state.drafts[key] ?? EMPTY).map((comment) =>
          comment.id === commentId ? { ...comment, body } : comment,
        ),
      },
    })),
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  removeComments: (key, comments) =>
    set((state) => {
      const submitted = new Map(comments.map((comment) => [comment.id, comment.body]));
      const remaining = (state.drafts[key] ?? EMPTY).filter(
        (entry) => submitted.get(entry.id) !== entry.body,
      );
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
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

/** The comments a pull request's draft holds, stable across renders while it is empty. */
export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}

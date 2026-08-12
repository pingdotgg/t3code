import type { PullRequestDiffSide, PullRequestRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface PendingReviewComment {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly side: PullRequestDiffSide;
  readonly body: string;
}

let sequence = 0;
export const EMPTY_PENDING_REVIEW_COMMENTS: readonly PendingReviewComment[] = [];

export function pullRequestReviewKey(reference: PullRequestRef): string {
  return `${reference.projectId}:${reference.repository}#${reference.number}`;
}

export function nextPendingReviewCommentId(): string {
  sequence += 1;
  return `review-comment-${sequence}`;
}

interface PullRequestReviewStore {
  readonly commentsByKey: Readonly<Record<string, readonly PendingReviewComment[]>>;
  readonly summariesByKey: Readonly<Record<string, string>>;
  readonly add: (key: string, comment: PendingReviewComment) => void;
  readonly remove: (key: string, commentId: string) => void;
  readonly removeSubmitted: (key: string, commentIds: readonly string[]) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, value: string) => void;
  readonly clearSubmitted: (key: string, value: string) => void;
}

export const usePullRequestReviewStore = create<PullRequestReviewStore>()((set) => ({
  commentsByKey: {},
  summariesByKey: {},
  add: (key, comment) =>
    set((state) => ({
      commentsByKey: {
        ...state.commentsByKey,
        [key]: [...(state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS), comment],
      },
    })),
  remove: (key, commentId) =>
    set((state) => {
      const remaining = (state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS).filter(
        (comment) => comment.id !== commentId,
      );
      if (remaining.length > 0) {
        return { commentsByKey: { ...state.commentsByKey, [key]: remaining } };
      }
      const { [key]: _removed, ...commentsByKey } = state.commentsByKey;
      return { commentsByKey };
    }),
  removeSubmitted: (key, commentIds) =>
    set((state) => {
      const submitted = new Set(commentIds);
      const remaining = (state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS).filter(
        (comment) => !submitted.has(comment.id),
      );
      if (remaining.length > 0) {
        return { commentsByKey: { ...state.commentsByKey, [key]: remaining } };
      }
      const { [key]: _removed, ...commentsByKey } = state.commentsByKey;
      return { commentsByKey };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...commentsByKey } = state.commentsByKey;
      return { commentsByKey };
    }),
  setSummary: (key, value) =>
    set((state) => ({ summariesByKey: { ...state.summariesByKey, [key]: value } })),
  clearSubmitted: (key, value) =>
    set((state) => {
      if (state.summariesByKey[key] !== value) return state;
      const { [key]: _removed, ...summariesByKey } = state.summariesByKey;
      return { summariesByKey };
    }),
}));

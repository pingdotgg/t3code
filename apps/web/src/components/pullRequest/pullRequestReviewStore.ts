import type { PullRequestRef, PullRequestReviewCommentDraft } from "@t3tools/contracts";
import { create } from "zustand";
import type { DiffFoldOverride } from "./pullRequestDiff.logic";

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

export interface PullRequestCodeViewState {
  readonly selectedCommitOid: string | null;
  readonly foldOverride: DiffFoldOverride;
  readonly toggledFiles: ReadonlySet<string>;
  readonly scrollTop: number;
  readonly loadedPageCount: number;
  readonly chromeCondensed: boolean;
}

export const EMPTY_CODE_VIEW: PullRequestCodeViewState = {
  selectedCommitOid: null,
  foldOverride: null,
  toggledFiles: new Set(),
  scrollTop: 0,
  loadedPageCount: 1,
  chromeCondensed: false,
};

export function pullRequestCodeViewKey(
  environmentId: string,
  threadId: string | null,
  reference: PullRequestRef,
) {
  return JSON.stringify([environmentId, threadId, pullRequestReviewKey(reference)]);
}

interface PullRequestReviewStoreState {
  readonly codeViews: Readonly<Record<string, PullRequestCodeViewState>>;
  readonly updateCodeView: (
    key: string,
    update: (current: PullRequestCodeViewState) => PullRequestCodeViewState,
  ) => void;
  readonly drafts: Readonly<Record<string, ReadonlyArray<PendingReviewComment>>>;
  readonly summaries: Readonly<Record<string, string>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (key: string, commentIds: ReadonlyArray<string>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  codeViews: {},
  updateCodeView: (key, update) =>
    set((state) => {
      const current = state.codeViews[key] ?? EMPTY_CODE_VIEW;
      const updated = update(current);
      // A session can see an unbounded sequence of renamed or replaced files.
      const next =
        updated.toggledFiles.size <= 2048
          ? updated
          : { ...updated, toggledFiles: new Set([...updated.toggledFiles].slice(-2048)) };
      if (next === current) return state;
      const codeViews = { ...state.codeViews };
      delete codeViews[key];
      codeViews[key] = next;
      // Review sessions outlive the active surface, without retaining every PR ever opened.
      for (const oldest of Object.keys(codeViews).slice(0, -32)) delete codeViews[oldest];
      return { codeViews };
    }),
  drafts: {},
  summaries: {},
  addComment: (key, comment) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
    })),
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  removeComments: (key, commentIds) =>
    set((state) => {
      const submitted = new Set(commentIds);
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => !submitted.has(entry.id));
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

export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}

export function readPullRequestCodeView(key: string) {
  return usePullRequestReviewStore.getState().codeViews[key] ?? EMPTY_CODE_VIEW;
}

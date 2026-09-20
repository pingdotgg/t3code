/**
 * A review being written, held until it is sent.
 *
 * Nothing here reaches the host: a review is one request carrying every line comment and the
 * verdict together, so a half-written one is invisible to everyone else — including on the
 * hosts that have no pending review of their own. That also means a draft lives only as long
 * as the tab does, which is why this is deliberately not persisted.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
} from "@t3tools/contracts";
import { create } from "zustand";
import type { SelectedLineRange } from "@pierre/diffs";
import type { ReviewCommentContext } from "~/reviewCommentContext";

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

export interface InlineReviewDraft {
  readonly fileKey: string;
  readonly range: SelectedLineRange;
  readonly text: string;
  readonly comment: ReviewCommentContext;
}

export interface PullRequestLineDraft {
  readonly fileKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
  readonly text: string;
}

export function reviewEditorKey(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  subject: string,
): string {
  return JSON.stringify([environmentId, pullRequestReviewKey(reference), subject]);
}

interface PullRequestReviewStoreState {
  readonly editorDrafts: Readonly<Record<string, string>>;
  readonly inlineDrafts: Readonly<Record<string, InlineReviewDraft>>;
  readonly lineDrafts: Readonly<Record<string, PullRequestLineDraft>>;
  readonly setEditorDraft: (key: string, text: string) => void;
  readonly clearEditorDraft: (key: string, submittedText: string) => void;
  readonly setInlineDraft: (key: string, draft: InlineReviewDraft | null) => void;
  readonly setLineDraft: (key: string, draft: PullRequestLineDraft | null) => void;
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
  editorDrafts: {},
  inlineDrafts: {},
  lineDrafts: {},
  setEditorDraft: (key, text) =>
    set((state) => ({ editorDrafts: { ...state.editorDrafts, [key]: text } })),
  clearEditorDraft: (key, submittedText) =>
    set((state) => {
      if (state.editorDrafts[key] !== submittedText) return state;
      const { [key]: _removed, ...rest } = state.editorDrafts;
      return { editorDrafts: rest };
    }),
  setInlineDraft: (key, draft) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.inlineDrafts;
      return { inlineDrafts: draft === null ? rest : { ...rest, [key]: draft } };
    }),
  setLineDraft: (key, draft) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.lineDrafts;
      return { lineDrafts: draft === null ? rest : { ...rest, [key]: draft } };
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

/** The comments a pull request's draft holds, stable across renders while it is empty. */
export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}

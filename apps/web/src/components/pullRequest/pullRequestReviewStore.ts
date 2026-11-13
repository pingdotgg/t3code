import type { SelectedLineRange } from "@pierre/diffs";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { DiffFoldOverride, FileDiffFoldChoices } from "./pullRequestDiff.logic";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };

// Content-derived ids can collide across comments; use a counter.
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

export function pullRequestCodeViewKey(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): string {
  return JSON.stringify([environmentId, pullRequestReviewKey(reference)]);
}

/** An inline comment being written. `version` is its file's content when the lines were picked. */
export interface PullRequestCodeDraft {
  readonly path: string;
  readonly oldPath: string | null;
  readonly version: number;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}

/**
 * Where a reader left a pull request's Code tab, kept for the session so that closing the panel,
 * opening a file or switching threads does not lose it. Files are named by path: the viewer's
 * own file keys change whenever a page of the diff does.
 */
interface PullRequestCodeView {
  readonly commit: string | null;
  readonly foldChoices: FileDiffFoldChoices;
  readonly foldOverride: DiffFoldOverride;
  readonly selectedLines: { readonly path: string; readonly range: SelectedLineRange } | null;
  readonly draft: PullRequestCodeDraft | null;
}

export const EMPTY_CODE_VIEW: PullRequestCodeView = {
  commit: null,
  foldChoices: new Map(),
  foldOverride: null,
  selectedLines: null,
  draft: null,
};

/** The file at the top of the viewport, how far into it, and how many diff pages were loaded. */
interface PullRequestCodePosition {
  readonly path: string;
  readonly offset: number;
  readonly pages: number;
}

const CODE_VIEW_LIMIT = 20;

interface PullRequestReviewStoreState {
  readonly codeViews: Readonly<Record<string, PullRequestCodeView>>;
  /** The text of each view's draft, apart from the view so typing re-renders only the composer. */
  readonly codeDraftTexts: Readonly<Record<string, string>>;
  readonly updateCodeView: (
    key: string,
    update: (view: PullRequestCodeView) => Partial<PullRequestCodeView>,
  ) => void;
  readonly setCodeDraftText: (key: string, text: string) => void;
  /** Written on every scroll; nothing that renders the diff reads it reactively. */
  readonly codePositions: Readonly<Record<string, PullRequestCodePosition>>;
  readonly saveCodePosition: (key: string, position: PullRequestCodePosition) => void;
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
  codeDraftTexts: {},
  updateCodeView: (key, update) =>
    set((state) => {
      const current = state.codeViews[key] ?? EMPTY_CODE_VIEW;
      const changes = update(current);
      // Folds, lines and position belong to one commit's diff.
      const next =
        changes.commit !== undefined && changes.commit !== current.commit
          ? { ...EMPTY_CODE_VIEW, ...changes }
          : { ...current, ...changes };
      if (
        next.commit === current.commit &&
        next.foldChoices === current.foldChoices &&
        next.foldOverride === current.foldOverride &&
        next.selectedLines === current.selectedLines &&
        next.draft === current.draft
      ) {
        return state;
      }
      const { [key]: _moved, ...others } = state.codeViews;
      const kept = Object.fromEntries(Object.entries(others).slice(1 - CODE_VIEW_LIMIT));
      const { [key]: _position, ...positions } = state.codePositions;
      return {
        codeViews: { ...kept, [key]: next },
        codePositions: next.commit === current.commit ? state.codePositions : positions,
        // A draft's text goes with its anchor.
        codeDraftTexts: Object.fromEntries(
          Object.entries(state.codeDraftTexts).filter(([owner]) =>
            owner === key ? next.draft === current.draft : owner in kept,
          ),
        ),
      };
    }),
  setCodeDraftText: (key, text) =>
    set((state) => ({ codeDraftTexts: { ...state.codeDraftTexts, [key]: text } })),
  codePositions: {},
  saveCodePosition: (key, position) =>
    set((state) => {
      const { [key]: _moved, ...others } = state.codePositions;
      const kept = Object.fromEntries(Object.entries(others).slice(1 - CODE_VIEW_LIMIT));
      return { codePositions: { ...kept, [key]: position } };
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
      // Keep summary edits made during submission; the textarea stays editable.
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

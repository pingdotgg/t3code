import { type PullRequestRef, PullRequestReviewCommentDraft } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { randomUUID } from "../../lib/utils";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };

// Content-derived ids can collide across comments, and a counter restarts below persisted ids.
export function nextPendingReviewCommentId(): string {
  return `pending-review-comment-${randomUUID()}`;
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
  readonly summaries: Readonly<Record<string, string>>;
  /** Unsent thread replies, so a reply form that remounts elsewhere reads the live draft. */
  readonly replies: Readonly<Record<string, string>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (key: string, commentIds: ReadonlyArray<string>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
  readonly setReply: (key: string, body: string) => void;
  readonly clearReply: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

const isCommentDraft = Schema.is(PullRequestReviewCommentDraft);
const isPendingComment = (entry: unknown): entry is PendingReviewComment =>
  isCommentDraft(entry) && typeof (entry as { id?: unknown }).id === "string";

type PersistedReviewDrafts = Pick<PullRequestReviewStoreState, "drafts" | "summaries">;

function restoreReviewDrafts(persisted: unknown): PersistedReviewDrafts {
  const candidate = persisted as Partial<Record<keyof PersistedReviewDrafts, unknown>> | null;
  const drafts: Record<string, ReadonlyArray<PendingReviewComment>> = {};
  for (const [key, comments] of Object.entries(candidate?.drafts ?? {})) {
    const valid = Array.isArray(comments) ? comments.filter(isPendingComment) : [];
    if (valid.length > 0) drafts[key] = valid;
  }
  const summaries: Record<string, string> = {};
  for (const [key, body] of Object.entries(candidate?.summaries ?? {})) {
    if (typeof body === "string") summaries[key] = body;
  }
  return { drafts, summaries };
}

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()(
  persist(
    (set) => ({
      drafts: {},
      summaries: {},
      replies: {},
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
          const remaining = (state.drafts[key] ?? EMPTY).filter(
            (entry) => !submitted.has(entry.id),
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
      setSummary: (key, body) =>
        set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
      clearSummary: (key, submittedBody) =>
        set((state) => {
          // Keep summary edits made during submission; the textarea stays editable.
          if (state.summaries[key] !== submittedBody) return state;
          const { [key]: _removed, ...rest } = state.summaries;
          return { summaries: rest };
        }),
      setReply: (key, body) => set((state) => ({ replies: { ...state.replies, [key]: body } })),
      clearReply: (key, submittedBody) =>
        set((state) => {
          if (state.replies[key]?.trim() !== submittedBody) return state;
          const { [key]: _removed, ...rest } = state.replies;
          return { replies: rest };
        }),
    }),
    {
      name: "t3code:pull-request-review-drafts:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof localStorage !== "undefined" ? localStorage : undefined),
      ),
      partialize: ({ drafts, summaries }) => ({ drafts, summaries }),
      merge: (persisted, current) => ({ ...current, ...restoreReviewDrafts(persisted) }),
    },
  ),
);

export function pullRequestThreadReplyKey(reference: PullRequestRef, threadId: string): string {
  return JSON.stringify([pullRequestReviewKey(reference), threadId]);
}

export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}

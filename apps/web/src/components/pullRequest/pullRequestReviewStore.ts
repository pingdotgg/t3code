/**
 * A review being written, held until it is sent.
 *
 * Nothing here reaches the host: a review is one request carrying every line comment and the
 * verdict together, so a half-written one is invisible to everyone else — including on the
 * hosts that have no pending review of their own. That also means a draft lives only as long
 * as the tab does, which is why this is deliberately not persisted.
 */
import type {
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewRevision,
} from "@t3tools/contracts";
import { create } from "zustand";

import { randomUUID } from "~/lib/utils";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };
export interface PendingReviewSubmission {
  readonly id: string;
  readonly verdict: "approve" | "request-changes" | "comment";
  readonly body: string;
  readonly comments: ReadonlyArray<PendingReviewComment>;
  readonly revision?: PullRequestReviewRevision;
}

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
  readonly revisions: Readonly<Record<string, PullRequestReviewRevision>>;
  readonly submissions: Readonly<Record<string, PendingReviewSubmission>>;
  readonly submissionAttempts: Readonly<Record<string, number>>;
  readonly inFlight: Readonly<Record<string, boolean>>;
  readonly addComment: (
    key: string,
    comment: PendingReviewComment,
    revision?: PullRequestReviewRevision,
  ) => boolean;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (key: string, commentIds: ReadonlyArray<string>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
  readonly startSubmission: (
    key: string,
    submission: Omit<PendingReviewSubmission, "id">,
  ) => { readonly submission: PendingReviewSubmission; readonly firstAttempt: boolean } | undefined;
  readonly finishSubmissionAttempt: (key: string, requestId: string) => void;
  readonly clearSubmission: (key: string, requestId: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set, get) => ({
  drafts: {},
  summaries: {},
  revisions: {},
  submissions: {},
  submissionAttempts: {},
  inFlight: {},
  addComment: (key, comment, revision) => {
    const existing = get().revisions[key];
    if (existing !== undefined && !sameReviewRevision(existing, revision)) return false;
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
      revisions:
        existing === undefined && revision !== undefined
          ? { ...state.revisions, [key]: revision }
          : state.revisions,
    }));
    return true;
  },
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      const { [key]: _revision, ...revisions } = state.revisions;
      return { drafts: rest, revisions };
    }),
  removeComments: (key, commentIds) =>
    set((state) => {
      const submitted = new Set(commentIds);
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => !submitted.has(entry.id));
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      const { [key]: _revision, ...revisions } = state.revisions;
      return { drafts: rest, revisions };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.drafts;
      const { [key]: _revision, ...revisions } = state.revisions;
      return { drafts: rest, revisions };
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
  startSubmission: (key, submission) => {
    if (get().inFlight[key] === true) return undefined;
    const existing = get().submissions[key];
    // A transport failure leaves the outcome unknown. Nothing editable may replace this exact
    // retry input until it succeeds; doing so would lose the only idempotency key that can safely
    // discover whether GitCafe accepted it.
    const pending =
      existing ??
      ({
        ...submission,
        id: randomUUID(),
        comments: submission.comments.map((comment) => ({ ...comment })),
        ...(submission.revision === undefined ? {} : { revision: { ...submission.revision } }),
      } satisfies PendingReviewSubmission);
    const attempts = get().submissionAttempts[key] ?? 0;
    set((state) => ({
      submissions: { ...state.submissions, [key]: pending },
      submissionAttempts: { ...state.submissionAttempts, [key]: attempts + 1 },
      inFlight: { ...state.inFlight, [key]: true },
    }));
    return { submission: pending, firstAttempt: attempts === 0 };
  },
  finishSubmissionAttempt: (key, requestId) =>
    set((state) => {
      if (state.submissions[key]?.id !== requestId) return state;
      const { [key]: _finished, ...inFlight } = state.inFlight;
      return { inFlight };
    }),
  clearSubmission: (key, requestId) =>
    set((state) => {
      if (state.submissions[key]?.id !== requestId) return state;
      const { [key]: _removed, ...rest } = state.submissions;
      const { [key]: _attempts, ...submissionAttempts } = state.submissionAttempts;
      const { [key]: _inFlight, ...inFlight } = state.inFlight;
      return { submissions: rest, submissionAttempts, inFlight };
    }),
}));

function sameReviewRevision(
  left: PullRequestReviewRevision,
  right: PullRequestReviewRevision | undefined,
): boolean {
  return (
    right !== undefined &&
    left.version === right.version &&
    left.headOid === right.headOid &&
    left.baseOid === right.baseOid
  );
}

/** The comments a pull request's draft holds, stable across renders while it is empty. */
export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}

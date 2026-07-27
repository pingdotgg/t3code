/**
 * Persisted drafts for in-progress answers to a provider's user-input request.
 *
 * These used to live in `ChatView` component state, which is destroyed when the
 * router swaps thread matches — switching threads silently discarded a typed
 * (but unsent) answer. Keying by `requestId` in a store outside the component
 * tree keeps the draft alive across thread switches and reloads until the
 * request stops being pending.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

const PENDING_USER_INPUT_DRAFT_STORAGE_KEY = "t3code:pending-user-input-drafts:v1";

/**
 * Upper bound on retained request drafts. Drafts are dropped once their request
 * stops being pending, but a request can also vanish while its thread isn't
 * mounted (answered elsewhere, thread deleted), so evict the oldest entries to
 * keep the persisted payload bounded.
 */
const MAX_RETAINED_REQUEST_DRAFTS = 50;

export type PendingUserInputDraftAnswers = Record<string, PendingUserInputDraftAnswer>;

/**
 * Answers and cursor position for one request. Both live in a single record so
 * eviction can never retain one half of a draft without the other.
 */
export interface PendingUserInputRequestDraft {
  answers: PendingUserInputDraftAnswers;
  questionIndex: number;
}

export const EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS: PendingUserInputDraftAnswers = Object.freeze(
  {},
);

const EMPTY_REQUEST_DRAFT: PendingUserInputRequestDraft = Object.freeze({
  answers: EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS,
  questionIndex: 0,
});

interface PendingUserInputDraftStoreState {
  draftsByRequestId: Record<string, PendingUserInputRequestDraft>;
  /** Applies `updater` to one question's draft answer within a request. */
  updateAnswer: (
    requestId: string,
    questionId: string,
    updater: (
      previous: PendingUserInputDraftAnswer | undefined,
    ) => PendingUserInputDraftAnswer | undefined,
  ) => void;
  setQuestionIndex: (requestId: string, questionIndex: number) => void;
  /** Drops a request's draft (called once the request stops being pending). */
  clearRequestDraft: (requestId: string) => void;
}

function createPendingUserInputDraftStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function removeRecordEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) {
    return record;
  }
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

function evictOldestRequestDrafts(
  draftsByRequestId: Record<string, PendingUserInputRequestDraft>,
  keepRequestId: string,
): Record<string, PendingUserInputRequestDraft> {
  const keys = Object.keys(draftsByRequestId);
  if (keys.length <= MAX_RETAINED_REQUEST_DRAFTS) {
    return draftsByRequestId;
  }
  const evictCount = keys.length - MAX_RETAINED_REQUEST_DRAFTS;
  const evicted = new Set(keys.filter((key) => key !== keepRequestId).slice(0, evictCount));
  if (evicted.size === 0) {
    return draftsByRequestId;
  }
  const remaining: Record<string, PendingUserInputRequestDraft> = {};
  for (const key of keys) {
    if (evicted.has(key)) continue;
    remaining[key] = draftsByRequestId[key] as PendingUserInputRequestDraft;
  }
  return remaining;
}

function withRequestDraft(
  state: PendingUserInputDraftStoreState,
  requestId: string,
  nextDraft: PendingUserInputRequestDraft,
): Pick<PendingUserInputDraftStoreState, "draftsByRequestId"> {
  return {
    draftsByRequestId: evictOldestRequestDrafts(
      { ...state.draftsByRequestId, [requestId]: nextDraft },
      requestId,
    ),
  };
}

export const usePendingUserInputDraftStore = create<PendingUserInputDraftStoreState>()(
  persist(
    (set) => ({
      draftsByRequestId: {},
      updateAnswer: (requestId, questionId, updater) =>
        set((state) => {
          const draft = state.draftsByRequestId[requestId] ?? EMPTY_REQUEST_DRAFT;
          const previousAnswer = draft.answers[questionId];
          const nextAnswer = updater(previousAnswer);
          if (nextAnswer === previousAnswer) {
            return state;
          }
          // Build via literal/rest rather than assignment: `record[key] = value`
          // hits the prototype setter for a `"__proto__"` question id instead of
          // creating an own property, which would drop the draft on serialize.
          const answers: PendingUserInputDraftAnswers =
            nextAnswer === undefined
              ? removeRecordEntry(draft.answers, questionId)
              : { ...draft.answers, [questionId]: nextAnswer };
          return withRequestDraft(state, requestId, { ...draft, answers });
        }),
      setQuestionIndex: (requestId, questionIndex) =>
        set((state) => {
          const draft = state.draftsByRequestId[requestId] ?? EMPTY_REQUEST_DRAFT;
          const normalizedIndex = Math.max(0, Math.floor(questionIndex));
          if (
            draft.questionIndex === normalizedIndex &&
            state.draftsByRequestId[requestId] !== undefined
          ) {
            return state;
          }
          return withRequestDraft(state, requestId, { ...draft, questionIndex: normalizedIndex });
        }),
      clearRequestDraft: (requestId) =>
        set((state) => {
          const draftsByRequestId = removeRecordEntry(state.draftsByRequestId, requestId);
          return draftsByRequestId === state.draftsByRequestId ? state : { draftsByRequestId };
        }),
    }),
    {
      name: PENDING_USER_INPUT_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createPendingUserInputDraftStorage),
      partialize: (state) => ({
        draftsByRequestId: state.draftsByRequestId,
      }),
    },
  ),
);

/** Draft answers for a request, or a stable empty record when there are none. */
export function usePendingUserInputDraftAnswers(
  requestId: string | null,
): PendingUserInputDraftAnswers {
  return usePendingUserInputDraftStore((state) =>
    requestId
      ? (state.draftsByRequestId[requestId]?.answers ?? EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS)
      : EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS,
  );
}

export function usePendingUserInputQuestionIndex(requestId: string | null): number {
  return usePendingUserInputDraftStore((state) =>
    requestId ? (state.draftsByRequestId[requestId]?.questionIndex ?? 0) : 0,
  );
}

export function clearPendingUserInputDraft(requestId: string): void {
  usePendingUserInputDraftStore.getState().clearRequestDraft(requestId);
}

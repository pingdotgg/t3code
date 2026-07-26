/**
 * Persisted drafts for in-progress answers to a provider's user-input request.
 *
 * These used to live in `ChatView` component state, which is destroyed when the
 * router swaps thread matches — switching threads silently discarded a typed
 * (but unsent) answer. Keying by `requestId` in a store outside the component
 * tree keeps the draft alive across thread switches and reloads until the
 * answer is actually submitted.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { resolveStorage } from "./lib/storage";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

const PENDING_USER_INPUT_DRAFT_STORAGE_KEY = "t3code:pending-user-input-drafts:v1";

/**
 * Upper bound on retained request drafts. Drafts are cleared when their answer
 * is submitted, but a request can also disappear without an answer (thread
 * deleted, turn interrupted), so evict the oldest entries to keep the persisted
 * payload bounded.
 */
const MAX_RETAINED_REQUEST_DRAFTS = 50;

export type PendingUserInputDraftAnswers = Record<string, PendingUserInputDraftAnswer>;

export const EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS: PendingUserInputDraftAnswers = Object.freeze(
  {},
);

interface PendingUserInputDraftStoreState {
  answersByRequestId: Record<string, PendingUserInputDraftAnswers>;
  questionIndexByRequestId: Record<string, number>;
  /** Applies `updater` to one question's draft answer within a request. */
  updateAnswer: (
    requestId: string,
    questionId: string,
    updater: (
      previous: PendingUserInputDraftAnswer | undefined,
    ) => PendingUserInputDraftAnswer | undefined,
  ) => void;
  setQuestionIndex: (requestId: string, questionIndex: number) => void;
  /** Drops every draft for a request (called once its answer is submitted). */
  clearRequestDraft: (requestId: string) => void;
}

function createPendingUserInputDraftStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function evictOldestRequestDrafts<T>(
  record: Record<string, T>,
  keepRequestId: string,
): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= MAX_RETAINED_REQUEST_DRAFTS) {
    return record;
  }
  const evictable = keys.filter((key) => key !== keepRequestId);
  const evictCount = keys.length - MAX_RETAINED_REQUEST_DRAFTS;
  const evicted = new Set(evictable.slice(0, evictCount));
  if (evicted.size === 0) {
    return record;
  }
  const next: Record<string, T> = {};
  for (const key of keys) {
    if (evicted.has(key)) continue;
    next[key] = record[key] as T;
  }
  return next;
}

function removeRecordEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) {
    return record;
  }
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

export const usePendingUserInputDraftStore = create<PendingUserInputDraftStoreState>()(
  persist(
    (set) => ({
      answersByRequestId: {},
      questionIndexByRequestId: {},
      updateAnswer: (requestId, questionId, updater) =>
        set((state) => {
          const requestAnswers = state.answersByRequestId[requestId];
          const nextAnswer = updater(requestAnswers?.[questionId]);
          if (nextAnswer === requestAnswers?.[questionId]) {
            return state;
          }
          // Build via literal/rest rather than assignment: `record[key] = value`
          // hits the prototype setter for a `"__proto__"` question id instead of
          // creating an own property, which would drop the draft on serialize.
          const nextRequestAnswers: PendingUserInputDraftAnswers =
            nextAnswer === undefined
              ? removeRecordEntry(requestAnswers ?? {}, questionId)
              : { ...requestAnswers, [questionId]: nextAnswer };
          return {
            answersByRequestId: evictOldestRequestDrafts(
              {
                ...state.answersByRequestId,
                [requestId]: nextRequestAnswers,
              },
              requestId,
            ),
          };
        }),
      setQuestionIndex: (requestId, questionIndex) =>
        set((state) => {
          const normalizedIndex = Math.max(0, Math.floor(questionIndex));
          if (state.questionIndexByRequestId[requestId] === normalizedIndex) {
            return state;
          }
          return {
            questionIndexByRequestId: evictOldestRequestDrafts(
              {
                ...state.questionIndexByRequestId,
                [requestId]: normalizedIndex,
              },
              requestId,
            ),
          };
        }),
      clearRequestDraft: (requestId) =>
        set((state) => {
          const nextAnswersByRequestId = removeRecordEntry(state.answersByRequestId, requestId);
          const nextQuestionIndexByRequestId = removeRecordEntry(
            state.questionIndexByRequestId,
            requestId,
          );
          if (
            nextAnswersByRequestId === state.answersByRequestId &&
            nextQuestionIndexByRequestId === state.questionIndexByRequestId
          ) {
            return state;
          }
          return {
            answersByRequestId: nextAnswersByRequestId,
            questionIndexByRequestId: nextQuestionIndexByRequestId,
          };
        }),
    }),
    {
      name: PENDING_USER_INPUT_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createPendingUserInputDraftStorage),
      partialize: (state) => ({
        answersByRequestId: state.answersByRequestId,
        questionIndexByRequestId: state.questionIndexByRequestId,
      }),
    },
  ),
);

/** Draft answers for a request, or a stable empty record when there are none. */
export function usePendingUserInputDraftAnswers(
  requestId: string | null,
): PendingUserInputDraftAnswers {
  return usePendingUserInputDraftStore(
    useShallow((state) =>
      requestId
        ? (state.answersByRequestId[requestId] ?? EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS,
    ),
  );
}

export function usePendingUserInputQuestionIndex(requestId: string | null): number {
  return usePendingUserInputDraftStore((state) =>
    requestId ? (state.questionIndexByRequestId[requestId] ?? 0) : 0,
  );
}

export function clearPendingUserInputDraft(requestId: string): void {
  usePendingUserInputDraftStore.getState().clearRequestDraft(requestId);
}

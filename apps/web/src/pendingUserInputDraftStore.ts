import type { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createDebouncedStorage } from "./composerDraftStore";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

export const PENDING_USER_INPUT_DRAFT_STORAGE_KEY = "t3code:pending-user-input-drafts:v1";

const pendingUserInputDebouncedStorage =
  typeof localStorage !== "undefined"
    ? createDebouncedStorage(localStorage)
    : { getItem: () => null, setItem: () => {}, removeItem: () => {}, flush: () => {} };

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    pendingUserInputDebouncedStorage.flush();
  });
}

interface PendingUserInputThreadDraftState {
  answersByRequestId: Record<ApprovalRequestId, Record<string, PendingUserInputDraftAnswer>>;
  questionIndexByRequestId: Record<ApprovalRequestId, number>;
}

interface PendingUserInputDraftStoreState {
  draftsByThreadId: Record<ThreadId, PendingUserInputThreadDraftState>;
  setQuestionIndex: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    questionIndex: number,
  ) => void;
  setAnswer: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    questionId: string,
    answer: PendingUserInputDraftAnswer,
  ) => void;
  clearInactiveRequests: (
    threadId: ThreadId,
    activeRequestIds: ReadonlyArray<ApprovalRequestId>,
  ) => void;
}

const EMPTY_PENDING_USER_INPUT_THREAD_DRAFT = Object.freeze({
  answersByRequestId: {},
  questionIndexByRequestId: {},
}) as PendingUserInputThreadDraftState;

function shouldRemoveThreadDraft(draft: PendingUserInputThreadDraftState | undefined): boolean {
  if (!draft) {
    return true;
  }
  return (
    Object.keys(draft.answersByRequestId).length === 0 &&
    Object.keys(draft.questionIndexByRequestId).length === 0
  );
}

export const usePendingUserInputDraftStore = create<PendingUserInputDraftStoreState>()(
  persist(
    (set) => ({
      draftsByThreadId: {},
      setQuestionIndex: (threadId, requestId, questionIndex) => {
        if (threadId.length === 0 || requestId.length === 0) {
          return;
        }
        set((state) => {
          const threadDraft =
            state.draftsByThreadId[threadId] ?? EMPTY_PENDING_USER_INPUT_THREAD_DRAFT;
          const nextQuestionIndex = Math.max(0, Math.floor(questionIndex));
          if (threadDraft.questionIndexByRequestId[requestId] === nextQuestionIndex) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                answersByRequestId: threadDraft.answersByRequestId,
                questionIndexByRequestId: {
                  ...threadDraft.questionIndexByRequestId,
                  [requestId]: nextQuestionIndex,
                },
              },
            },
          };
        });
      },
      setAnswer: (threadId, requestId, questionId, answer) => {
        if (threadId.length === 0 || requestId.length === 0 || questionId.length === 0) {
          return;
        }
        set((state) => {
          const threadDraft =
            state.draftsByThreadId[threadId] ?? EMPTY_PENDING_USER_INPUT_THREAD_DRAFT;
          const requestAnswers = threadDraft.answersByRequestId[requestId] ?? {};
          const currentAnswer = requestAnswers[questionId];
          if (
            currentAnswer?.answerSource === answer.answerSource &&
            currentAnswer?.customAnswer === answer.customAnswer &&
            currentAnswer?.selectedOptionLabel === answer.selectedOptionLabel
          ) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                answersByRequestId: {
                  ...threadDraft.answersByRequestId,
                  [requestId]: {
                    ...requestAnswers,
                    [questionId]: answer,
                  },
                },
                questionIndexByRequestId: threadDraft.questionIndexByRequestId,
              },
            },
          };
        });
      },
      clearInactiveRequests: (threadId, activeRequestIds) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const threadDraft = state.draftsByThreadId[threadId];
          if (!threadDraft) {
            return state;
          }
          const activeRequestIdSet = new Set(activeRequestIds);
          let answersChanged = false;
          const nextAnswersByRequestId = Object.fromEntries(
            Object.entries(threadDraft.answersByRequestId).filter(([requestId]) => {
              const keep = activeRequestIdSet.has(requestId as ApprovalRequestId);
              answersChanged ||= !keep;
              return keep;
            }),
          ) as PendingUserInputThreadDraftState["answersByRequestId"];
          let indexChanged = false;
          const nextQuestionIndexByRequestId = Object.fromEntries(
            Object.entries(threadDraft.questionIndexByRequestId).filter(([requestId]) => {
              const keep = activeRequestIdSet.has(requestId as ApprovalRequestId);
              indexChanged ||= !keep;
              return keep;
            }),
          ) as PendingUserInputThreadDraftState["questionIndexByRequestId"];
          if (!answersChanged && !indexChanged) {
            return state;
          }
          const nextThreadDraft: PendingUserInputThreadDraftState = {
            answersByRequestId: nextAnswersByRequestId,
            questionIndexByRequestId: nextQuestionIndexByRequestId,
          };
          if (shouldRemoveThreadDraft(nextThreadDraft)) {
            const { [threadId]: _removed, ...restDraftsByThreadId } = state.draftsByThreadId;
            return { draftsByThreadId: restDraftsByThreadId };
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: nextThreadDraft,
            },
          };
        });
      },
    }),
    {
      name: PENDING_USER_INPUT_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => pendingUserInputDebouncedStorage),
      partialize: (state) => ({
        draftsByThreadId: Object.fromEntries(
          Object.entries(state.draftsByThreadId).filter(
            ([, draft]) => !shouldRemoveThreadDraft(draft),
          ),
        ) as Record<ThreadId, PendingUserInputThreadDraftState>,
      }),
    },
  ),
);

export function usePendingUserInputThreadDraft(
  threadId: ThreadId,
): PendingUserInputThreadDraftState {
  return usePendingUserInputDraftStore(
    (state) => state.draftsByThreadId[threadId] ?? EMPTY_PENDING_USER_INPUT_THREAD_DRAFT,
  );
}

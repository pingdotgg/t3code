import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

interface PendingUserInputRequestState {
  answersByQuestionId: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
}

interface ThreadPendingUserInputState {
  requestsById: Record<string, PendingUserInputRequestState>;
}

interface PendingUserInputStoreState {
  threadStateByThreadId: Record<ThreadId, ThreadPendingUserInputState>;
  setQuestionIndex: (threadId: ThreadId, requestId: string, questionIndex: number) => void;
  setQuestionAnswer: (
    threadId: ThreadId,
    requestId: string,
    questionId: string,
    answer: PendingUserInputDraftAnswer,
  ) => void;
  syncThreadRequests: (threadId: ThreadId, activeRequestIds: ReadonlySet<string>) => void;
}

const EMPTY_PENDING_USER_INPUT_REQUEST_STATE = Object.freeze({
  answersByQuestionId: {},
  questionIndex: 0,
}) as PendingUserInputRequestState;

function getThreadPendingUserInputState(
  threadStateByThreadId: Record<ThreadId, ThreadPendingUserInputState>,
  threadId: ThreadId,
): ThreadPendingUserInputState | null {
  return threadStateByThreadId[threadId] ?? null;
}

export function selectPendingUserInputRequestState(
  threadStateByThreadId: Record<ThreadId, ThreadPendingUserInputState>,
  threadId: ThreadId,
  requestId: string,
): PendingUserInputRequestState {
  return (
    getThreadPendingUserInputState(threadStateByThreadId, threadId)?.requestsById[requestId] ??
    EMPTY_PENDING_USER_INPUT_REQUEST_STATE
  );
}

function updateRequestState(
  threadStateByThreadId: Record<ThreadId, ThreadPendingUserInputState>,
  threadId: ThreadId,
  requestId: string,
  updater: (current: PendingUserInputRequestState) => PendingUserInputRequestState,
): Record<ThreadId, ThreadPendingUserInputState> {
  const currentThreadState = getThreadPendingUserInputState(threadStateByThreadId, threadId);
  const currentRequestState =
    currentThreadState?.requestsById[requestId] ?? EMPTY_PENDING_USER_INPUT_REQUEST_STATE;
  const nextRequestState = updater(currentRequestState);

  if (nextRequestState === currentRequestState) {
    return threadStateByThreadId;
  }

  return {
    ...threadStateByThreadId,
    [threadId]: {
      requestsById: {
        ...currentThreadState?.requestsById,
        [requestId]: nextRequestState,
      },
    },
  };
}

export const usePendingUserInputStore = create<PendingUserInputStoreState>()((set) => ({
  threadStateByThreadId: {},
  setQuestionIndex: (threadId, requestId, questionIndex) =>
    set((state) => {
      const nextThreadStateByThreadId = updateRequestState(
        state.threadStateByThreadId,
        threadId,
        requestId,
        (current) => {
          if (current.questionIndex === questionIndex) {
            return current;
          }
          return {
            answersByQuestionId: current.answersByQuestionId,
            questionIndex,
          };
        },
      );
      return nextThreadStateByThreadId === state.threadStateByThreadId
        ? state
        : { threadStateByThreadId: nextThreadStateByThreadId };
    }),
  setQuestionAnswer: (threadId, requestId, questionId, answer) =>
    set((state) => {
      const nextThreadStateByThreadId = updateRequestState(
        state.threadStateByThreadId,
        threadId,
        requestId,
        (current) => {
          const currentAnswer = current.answersByQuestionId[questionId];
          if (
            currentAnswer?.selectedOptionLabel === answer.selectedOptionLabel &&
            currentAnswer?.customAnswer === answer.customAnswer
          ) {
            return current;
          }
          return {
            questionIndex: current.questionIndex,
            answersByQuestionId: {
              ...current.answersByQuestionId,
              [questionId]: answer,
            },
          };
        },
      );
      return nextThreadStateByThreadId === state.threadStateByThreadId
        ? state
        : { threadStateByThreadId: nextThreadStateByThreadId };
    }),
  syncThreadRequests: (threadId, activeRequestIds) =>
    set((state) => {
      const currentThreadState = getThreadPendingUserInputState(state.threadStateByThreadId, threadId);
      if (!currentThreadState) {
        return state;
      }

      const staleRequestIds = Object.keys(currentThreadState.requestsById).filter(
        (requestId) => !activeRequestIds.has(requestId),
      );
      if (staleRequestIds.length === 0) {
        return state;
      }

      const nextRequestsById = { ...currentThreadState.requestsById };
      for (const requestId of staleRequestIds) {
        delete nextRequestsById[requestId];
      }

      if (Object.keys(nextRequestsById).length === 0) {
        const { [threadId]: _removed, ...restThreadStateByThreadId } = state.threadStateByThreadId;
        return { threadStateByThreadId: restThreadStateByThreadId };
      }

      return {
        threadStateByThreadId: {
          ...state.threadStateByThreadId,
          [threadId]: {
            requestsById: nextRequestsById,
          },
        },
      };
    }),
}));

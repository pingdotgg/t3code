import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Ephemeral (non-persisted), display-only import of a resumed Claude Code
 * session's past text messages, keyed by the T3 thread that's resuming it.
 * These never become real orchestration events/messages — `ChatView` merges
 * them into the rendered timeline ahead of the thread's own (live) messages,
 * purely so the user can see what they're continuing.
 *
 * Deliberately a separate store from `resumeSessionIntentStore`: the intent
 * (and its "Resuming a previous Claude session" banner) is cleared the
 * moment the first message sends, but the imported history should keep
 * rendering as part of the thread's visible context for as long as the
 * thread is open.
 */
export interface ResumeSessionHistoryMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

interface ResumeSessionHistoryStoreState {
  readonly historyByThreadId: Partial<Record<ThreadId, ReadonlyArray<ResumeSessionHistoryMessage>>>;
  readonly setResumeSessionHistory: (
    threadId: ThreadId,
    messages: ReadonlyArray<ResumeSessionHistoryMessage>,
  ) => void;
  readonly clearResumeSessionHistory: (threadId: ThreadId) => void;
}

export const useResumeSessionHistoryStore = create<ResumeSessionHistoryStoreState>((set) => ({
  historyByThreadId: {},
  setResumeSessionHistory: (threadId, messages) => {
    set((state) => ({
      historyByThreadId: { ...state.historyByThreadId, [threadId]: messages },
    }));
  },
  clearResumeSessionHistory: (threadId) => {
    set((state) => {
      if (!(threadId in state.historyByThreadId)) return state;
      const next = { ...state.historyByThreadId };
      delete next[threadId];
      return { historyByThreadId: next };
    });
  },
}));

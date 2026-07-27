import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Ephemeral (non-persisted) link between a not-yet-created draft thread and
 * an on-disk Claude Code session the user picked to resume. Deliberately
 * kept outside `composerDraftStore` (which is persisted and drives a lot of
 * draft-lifecycle logic) — this only needs to survive from "user picked a
 * session in the resume dialog" to "user sends the first message of that
 * draft", at which point `ChatView` consumes and clears it.
 */
interface ResumeSessionIntentStoreState {
  readonly intentByThreadId: Partial<Record<ThreadId, string>>;
  readonly setResumeSessionIntent: (threadId: ThreadId, resumeExternalSessionId: string) => void;
  readonly clearResumeSessionIntent: (threadId: ThreadId) => void;
}

export const useResumeSessionIntentStore = create<ResumeSessionIntentStoreState>((set) => ({
  intentByThreadId: {},
  setResumeSessionIntent: (threadId, resumeExternalSessionId) => {
    set((state) => ({
      intentByThreadId: { ...state.intentByThreadId, [threadId]: resumeExternalSessionId },
    }));
  },
  clearResumeSessionIntent: (threadId) => {
    set((state) => {
      if (!(threadId in state.intentByThreadId)) return state;
      const next = { ...state.intentByThreadId };
      delete next[threadId];
      return { intentByThreadId: next };
    });
  },
}));

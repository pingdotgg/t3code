/**
 * The first thing to say in a report's conversation, decided on the report
 * screen and consumed by the chat view when the thread opens.
 *
 * A decision is made where the evidence is. Carrying the intent across means
 * the reader never lands in an empty composer wondering what they just
 * agreed to — the conversation opens already saying it.
 */
import { create } from "zustand";

interface ReportIntentStore {
  readonly intentByThreadId: Readonly<Record<string, string>>;
  readonly setIntent: (threadId: string, text: string) => void;
  /** Reads the intent and clears it, so a thread never re-sends on remount. */
  readonly takeIntent: (threadId: string) => string | null;
}

export const useReportIntentStore = create<ReportIntentStore>((set, get) => ({
  intentByThreadId: {},
  setIntent: (threadId, text) =>
    set((state) => ({ intentByThreadId: { ...state.intentByThreadId, [threadId]: text } })),
  takeIntent: (threadId) => {
    const text = get().intentByThreadId[threadId];
    if (text === undefined) return null;
    set((state) => {
      const next = { ...state.intentByThreadId };
      delete next[threadId];
      return { intentByThreadId: next };
    });
    return text;
  },
}));

/** What "Implement it" says to the agent, before any direction the reader adds. */
export const IMPLEMENT_INTENT =
  "Implement the fix this report describes. Work on the current branch, then open a pull request whose body links the report.";

/** What "Ask about it" opens with: nothing. The reader types their own question. */
export const ASK_INTENT = "";

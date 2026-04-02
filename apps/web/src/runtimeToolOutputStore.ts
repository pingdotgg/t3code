import { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

interface RuntimeToolOutputState {
  outputsByThreadId: Record<string, Record<string, string>>;
  appendOutput: (threadId: ThreadId, itemId: string, delta: string) => void;
  clearThread: (threadId: ThreadId) => void;
  clearAll: () => void;
}

const MAX_OUTPUT_CHARS_PER_ITEM = 24_000;

export const useRuntimeToolOutputStore = create<RuntimeToolOutputState>((set) => ({
  outputsByThreadId: {},
  appendOutput: (threadId, itemId, delta) =>
    set((state) => {
      const threadOutputs = state.outputsByThreadId[threadId] ?? {};
      const previous = threadOutputs[itemId] ?? "";
      const next = `${previous}${delta}`;
      return {
        outputsByThreadId: {
          ...state.outputsByThreadId,
          [threadId]: {
            ...threadOutputs,
            [itemId]:
              next.length > MAX_OUTPUT_CHARS_PER_ITEM
                ? next.slice(next.length - MAX_OUTPUT_CHARS_PER_ITEM)
                : next,
          },
        },
      };
    }),
  clearThread: (threadId) =>
    set((state) => {
      if (!(threadId in state.outputsByThreadId)) {
        return state;
      }
      const next = { ...state.outputsByThreadId };
      delete next[threadId];
      return { outputsByThreadId: next };
    }),
  clearAll: () => set({ outputsByThreadId: {} }),
}));

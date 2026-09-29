import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type SideChatHistoryChoice = "with" | "without";

interface SideChatPreferenceState {
  /** What the split "+" starts, so the common choice is one click. */
  history: SideChatHistoryChoice;
  setHistory: (history: SideChatHistoryChoice) => void;
}

export const useSideChatPreferenceStore = create<SideChatPreferenceState>()(
  persist(
    (set) => ({
      history: "with",
      setHistory: (history) => set({ history }),
    }),
    {
      name: "t3code:side-chat-preference:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ history: state.history }),
    },
  ),
);

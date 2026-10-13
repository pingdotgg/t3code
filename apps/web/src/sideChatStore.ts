import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { RightPanelSurface } from "./rightPanelStore";

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

interface SideChatFocusState {
  /**
   * Parent thread key to the side chat its composer talks to. It counts only
   * while that side chat's tab is the open panel's active one, see
   * `resolveFocusedSideChat`.
   */
  byParent: Record<string, ThreadId>;
  focus: (parentKey: string, childThreadId: ThreadId) => void;
  /** Back to the parent; with a child id, only if that side chat still has focus. */
  release: (parentKey: string, childThreadId?: ThreadId) => void;
}

export const useSideChatFocusStore = create<SideChatFocusState>()((set) => ({
  byParent: {},
  focus: (parentKey, childThreadId) =>
    set((state) =>
      state.byParent[parentKey] === childThreadId
        ? state
        : { byParent: { ...state.byParent, [parentKey]: childThreadId } },
    ),
  release: (parentKey, childThreadId) =>
    set((state) => {
      const current = state.byParent[parentKey];
      if (current === undefined || (childThreadId !== undefined && current !== childThreadId)) {
        return state;
      }
      const { [parentKey]: _released, ...byParent } = state.byParent;
      return { byParent };
    }),
}));

/**
 * The side chat a thread's composer talks to: the one picked, while its tab is
 * the active surface of an open panel. Closing the panel or switching tabs
 * hands the composer back without anything having to release it.
 */
export function resolveFocusedSideChat(input: {
  readonly picked: ThreadId | null;
  readonly panelOpen: boolean;
  readonly activeSurface: RightPanelSurface | null;
}): ThreadId | null {
  const { picked, activeSurface } = input;
  return picked !== null &&
    input.panelOpen &&
    activeSurface?.kind === "aside" &&
    activeSurface.threadId === picked
    ? picked
    : null;
}

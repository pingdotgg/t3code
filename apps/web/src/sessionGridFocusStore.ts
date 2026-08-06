import { create } from "zustand";

interface SessionGridFocusState {
  /** Scoped server-thread key whose grid pane currently owns workspace focus. */
  focusedThreadKey: string | null;
  setFocusedThreadKey: (threadKey: string | null) => void;
}

// fork: project session grid — ephemeral bridge from grid focus to the shared
// project sidebar. Route selection remains authoritative outside the grid.
export const useSessionGridFocusStore = create<SessionGridFocusState>((set) => ({
  focusedThreadKey: null,
  setFocusedThreadKey: (focusedThreadKey) => set({ focusedThreadKey }),
}));

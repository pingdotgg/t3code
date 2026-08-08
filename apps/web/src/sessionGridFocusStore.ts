import { create } from "zustand";
import type { SessionGridChangeRequestState } from "./components/sessionGrid/sessionGrid.logic";

interface SessionGridFocusState {
  /** Scoped server-thread key whose grid pane currently owns workspace focus. */
  focusedThreadKey: string | null;
  /** Draft id whose not-yet-started grid pane currently owns workspace focus. */
  focusedDraftId: string | null;
  /** Branch-scoped PR state shared with the grid-only project navigator. */
  changeRequestStateByKey: ReadonlyMap<string, SessionGridChangeRequestState>;
  setFocusedThreadKey: (threadKey: string | null) => void;
  setFocusedDraftId: (draftId: string | null) => void;
  setChangeRequestStateByKey: (
    stateByKey: ReadonlyMap<string, SessionGridChangeRequestState>,
  ) => void;
}

// fork: project session grid — ephemeral bridge from grid focus to the shared
// project sidebar. Route selection remains authoritative outside the grid.
export const useSessionGridFocusStore = create<SessionGridFocusState>((set) => ({
  focusedThreadKey: null,
  focusedDraftId: null,
  changeRequestStateByKey: new Map(),
  setFocusedThreadKey: (focusedThreadKey) => set({ focusedThreadKey }),
  setFocusedDraftId: (focusedDraftId) => set({ focusedDraftId }),
  setChangeRequestStateByKey: (changeRequestStateByKey) => set({ changeRequestStateByKey }),
}));

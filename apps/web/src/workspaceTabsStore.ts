import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import {
  clampSplitRatio,
  closeTabs,
  EMPTY_WORKSPACE_TABS,
  moveTab,
  openSplit,
  reopenClosedTab,
  sanitizeWorkspaceTabs,
  togglePinnedTab,
  visitTab,
  type WorkspaceTabsState,
} from "./workspaceTabs.logic";

interface WorkspaceTabsStore extends WorkspaceTabsState {
  readonly visit: (key: string) => void;
  readonly close: (keys: ReadonlyArray<string>) => void;
  /** Returns the reopened thread key, or null when nothing is left to reopen. */
  readonly reopen: () => string | null;
  readonly togglePin: (key: string) => void;
  readonly move: (from: string, to: string) => void;
  readonly openSplit: (key: string, activeKey: string | null) => void;
  readonly closeSplit: () => void;
  readonly setSplitRatio: (ratio: number) => void;
}

const pick = (state: WorkspaceTabsState): WorkspaceTabsState => ({
  tabs: state.tabs,
  closed: state.closed,
  split: state.split,
});

/** Open thread tabs for this window, kept across restarts in local storage. */
export const useWorkspaceTabsStore = create<WorkspaceTabsStore>()(
  persist<WorkspaceTabsStore, [], [], WorkspaceTabsState>(
    (set, get) => ({
      ...EMPTY_WORKSPACE_TABS,
      visit: (key) => set((state) => visitTab(pick(state), key)),
      close: (keys) => set((state) => closeTabs(pick(state), keys)),
      reopen: () => {
        const result = reopenClosedTab(pick(get()));
        set(result.state);
        return result.key;
      },
      togglePin: (key) => set((state) => togglePinnedTab(pick(state), key)),
      move: (from, to) => set((state) => moveTab(pick(state), from, to)),
      openSplit: (key, activeKey) => set((state) => openSplit(pick(state), key, activeKey)),
      closeSplit: () => set({ split: null }),
      setSplitRatio: (ratio) =>
        set((state) =>
          state.split ? { split: { ...state.split, ratio: clampSplitRatio(ratio) } } : state,
        ),
    }),
    {
      name: "continuum:workspace-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: pick,
      merge: (persisted, current) => ({ ...current, ...sanitizeWorkspaceTabs(persisted) }),
    },
  ),
);

import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type RightPanelKind = "diff" | "browser";

export interface ThreadRightPanelState {
  selectedPanel: RightPanelKind | null;
  lastSelectedPanel: RightPanelKind;
}

const RIGHT_PANEL_STATE_STORAGE_KEY = "t3code:right-panel-state:v1";

const DEFAULT_THREAD_RIGHT_PANEL_STATE: ThreadRightPanelState = Object.freeze({
  selectedPanel: null,
  lastSelectedPanel: "diff",
});

function normalizeThreadRightPanelState(state: ThreadRightPanelState): ThreadRightPanelState {
  const selectedPanel =
    state.selectedPanel === "diff" || state.selectedPanel === "browser"
      ? state.selectedPanel
      : null;
  const lastSelectedPanel = state.lastSelectedPanel === "browser" ? "browser" : "diff";
  if (selectedPanel === state.selectedPanel && lastSelectedPanel === state.lastSelectedPanel) {
    return state;
  }
  return { selectedPanel, lastSelectedPanel };
}

function isDefaultThreadRightPanelState(state: ThreadRightPanelState): boolean {
  const normalized = normalizeThreadRightPanelState(state);
  return (
    normalized.selectedPanel === DEFAULT_THREAD_RIGHT_PANEL_STATE.selectedPanel &&
    normalized.lastSelectedPanel === DEFAULT_THREAD_RIGHT_PANEL_STATE.lastSelectedPanel
  );
}

export function selectThreadRightPanelState(
  rightPanelStateByThreadId: Record<ThreadId, ThreadRightPanelState>,
  threadId: ThreadId,
): ThreadRightPanelState {
  if (threadId.length === 0) {
    return DEFAULT_THREAD_RIGHT_PANEL_STATE;
  }
  return rightPanelStateByThreadId[threadId] ?? DEFAULT_THREAD_RIGHT_PANEL_STATE;
}

function updateRightPanelStateByThreadId(
  rightPanelStateByThreadId: Record<ThreadId, ThreadRightPanelState>,
  threadId: ThreadId,
  updater: (state: ThreadRightPanelState) => ThreadRightPanelState,
): Record<ThreadId, ThreadRightPanelState> {
  if (threadId.length === 0) {
    return rightPanelStateByThreadId;
  }

  const current = selectThreadRightPanelState(rightPanelStateByThreadId, threadId);
  const next = normalizeThreadRightPanelState(updater(current));
  if (
    next === current ||
    (next.selectedPanel === current.selectedPanel &&
      next.lastSelectedPanel === current.lastSelectedPanel)
  ) {
    return rightPanelStateByThreadId;
  }

  if (isDefaultThreadRightPanelState(next)) {
    if (rightPanelStateByThreadId[threadId] === undefined) {
      return rightPanelStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = rightPanelStateByThreadId;
    return rest as Record<ThreadId, ThreadRightPanelState>;
  }

  return {
    ...rightPanelStateByThreadId,
    [threadId]: next,
  };
}

interface RightPanelStateStoreState {
  rightPanelStateByThreadId: Record<ThreadId, ThreadRightPanelState>;
  setSelectedPanel: (threadId: ThreadId, panel: RightPanelKind | null) => void;
  removeOrphanedRightPanelStates: (activeThreadIds: Set<ThreadId>) => void;
}

export const useRightPanelStateStore = create<RightPanelStateStoreState>()(
  persist(
    (set) => ({
      rightPanelStateByThreadId: {},
      setSelectedPanel: (threadId, panel) =>
        set((state) => ({
          rightPanelStateByThreadId: updateRightPanelStateByThreadId(
            state.rightPanelStateByThreadId,
            threadId,
            (current) => ({
              selectedPanel: panel,
              lastSelectedPanel: panel ?? current.lastSelectedPanel,
            }),
          ),
        })),
      removeOrphanedRightPanelStates: (activeThreadIds) =>
        set((state) => {
          const orphanedIds = Object.keys(state.rightPanelStateByThreadId).filter(
            (id) => !activeThreadIds.has(id as ThreadId),
          );
          if (orphanedIds.length === 0) {
            return state;
          }
          const next = { ...state.rightPanelStateByThreadId };
          for (const id of orphanedIds) {
            delete next[id as ThreadId];
          }
          return { rightPanelStateByThreadId: next };
        }),
    }),
    {
      name: RIGHT_PANEL_STATE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        rightPanelStateByThreadId: state.rightPanelStateByThreadId,
      }),
    },
  ),
);

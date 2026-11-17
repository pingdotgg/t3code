import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

// Where each thread's Tasks tab is, kept outside the panel because only the active surface
// mounts. Keyed per thread like the panel's tabs; other panel apps keep their own state.

export type TasksDetailTab = "brief" | "agents";

export interface TasksNavigation {
  readonly view: "board" | "task";
  /** Kept while the board shows, so reopening the same task restores its place. */
  readonly taskId: number | null;
  /** Null shows the task's own brief. */
  readonly subtaskId: number | null;
  readonly tab: TasksDetailTab;
  readonly boardScroll: { readonly top: number; readonly left: number };
  readonly detailScrollTop: number;
}

export const DEFAULT_TASKS_NAVIGATION: TasksNavigation = {
  view: "board",
  taskId: null,
  subtaskId: null,
  tab: "brief",
  boardScroll: { top: 0, left: 0 },
  detailScrollTop: 0,
};

interface TasksPanelState {
  readonly byThreadKey: Readonly<Record<string, TasksNavigation>>;
  readonly openTask: (threadKey: string, taskId: number) => void;
  /** `tab` switches the content tab too; without it the current tab stays. */
  readonly openSubtask: (threadKey: string, subtaskId: number | null, tab?: TasksDetailTab) => void;
  readonly setTab: (threadKey: string, tab: TasksDetailTab) => void;
  readonly showBoard: (threadKey: string) => void;
  readonly saveBoardScroll: (threadKey: string, top: number, left: number) => void;
  readonly saveDetailScroll: (threadKey: string, top: number) => void;
}

export const useTasksPanelStore = create<TasksPanelState>()(
  persist(
    (set) => {
      const update = (threadKey: string, change: (current: TasksNavigation) => TasksNavigation) =>
        set((state) => {
          const current = state.byThreadKey[threadKey] ?? DEFAULT_TASKS_NAVIGATION;
          const next = change(current);
          if (next === current) return state;
          return { byThreadKey: { ...state.byThreadKey, [threadKey]: next } };
        });
      return {
        byThreadKey: {},
        openTask: (threadKey, taskId) =>
          update(threadKey, (current) =>
            current.taskId === taskId
              ? { ...current, view: "task" }
              : {
                  ...current,
                  view: "task",
                  taskId,
                  subtaskId: null,
                  tab: "brief",
                  detailScrollTop: 0,
                },
          ),
        openSubtask: (threadKey, subtaskId, tab) =>
          update(threadKey, (current) =>
            current.subtaskId === subtaskId && (tab === undefined || tab === current.tab)
              ? current
              : { ...current, subtaskId, tab: tab ?? current.tab, detailScrollTop: 0 },
          ),
        setTab: (threadKey, tab) =>
          update(threadKey, (current) =>
            current.tab === tab ? current : { ...current, tab, detailScrollTop: 0 },
          ),
        showBoard: (threadKey) =>
          update(threadKey, (current) =>
            current.view === "board" ? current : { ...current, view: "board" },
          ),
        saveBoardScroll: (threadKey, top, left) =>
          update(threadKey, (current) =>
            current.boardScroll.top === top && current.boardScroll.left === left
              ? current
              : { ...current, boardScroll: { top, left } },
          ),
        saveDetailScroll: (threadKey, top) =>
          update(threadKey, (current) =>
            current.detailScrollTop === top ? current : { ...current, detailScrollTop: top },
          ),
      };
    },
    {
      name: "conn:tasks-panel:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function useTasksNavigation(threadKey: string): TasksNavigation {
  return useTasksPanelStore((state) => state.byThreadKey[threadKey] ?? DEFAULT_TASKS_NAVIGATION);
}

/** The store's actions, for event handlers. */
export function tasksPanelActions(): TasksPanelState {
  return useTasksPanelStore.getState();
}

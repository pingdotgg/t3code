import type { OrbitTaskLane } from "@t3tools/client-runtime/orbit-gateway";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

// Where each thread's Tasks tab is, kept outside the panel because only the active surface
// mounts. Keyed per thread like the panel's tabs; other panel apps keep their own state.

export type TasksDetailTab = "brief" | "agents";

export interface TasksNavigation {
  readonly originThreadKey?: string;
  readonly view: "board" | "task";
  /** Kept while the board shows, so reopening the same task restores its place. */
  readonly taskId: number | null;
  /** Null shows the task's own brief. */
  readonly subtaskId: number | null;
  readonly tab: TasksDetailTab;
  /** Inside a subtask: the tab the task itself had open, restored when the path leads back. */
  readonly taskTab?: TasksDetailTab | undefined;
  readonly boardScroll: { readonly top: number; readonly left: number };
  readonly detailScrollTop: number;
  /** When this thread's Tasks navigation last changed, for the cap below. */
  readonly updatedAt: number;
}

/** Only the threads changed most recently keep their place, so storage stays bounded. */
export const TASKS_NAVIGATION_THREAD_LIMIT = 50;

function capThreads(
  byThreadKey: Readonly<Record<string, TasksNavigation>>,
): Readonly<Record<string, TasksNavigation>> {
  const entries = Object.entries(byThreadKey);
  if (entries.length <= TASKS_NAVIGATION_THREAD_LIMIT) return byThreadKey;
  return Object.fromEntries(
    entries
      .toSorted(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, TASKS_NAVIGATION_THREAD_LIMIT),
  );
}

export const DEFAULT_TASKS_NAVIGATION: TasksNavigation = {
  view: "board",
  taskId: null,
  subtaskId: null,
  tab: "brief",
  boardScroll: { top: 0, left: 0 },
  detailScrollTop: 0,
  updatedAt: 0,
};

interface TasksPanelState {
  readonly byThreadKey: Readonly<Record<string, TasksNavigation>>;
  readonly handoff: (sourceKey: string, targetKey: string) => void;
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
          return {
            byThreadKey: capThreads({
              ...state.byThreadKey,
              [threadKey]: { ...next, updatedAt: Date.now() },
            }),
          };
        });
      return {
        byThreadKey: {},
        handoff: (sourceKey, targetKey) =>
          set((state) => {
            const source = state.byThreadKey[sourceKey];
            if (!source || sourceKey === targetKey || source.originThreadKey === targetKey)
              return state;
            return {
              byThreadKey: capThreads({
                ...state.byThreadKey,
                [targetKey]: {
                  ...source,
                  originThreadKey: source.originThreadKey ?? sourceKey,
                  updatedAt: Date.now(),
                },
              }),
            };
          }),
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
                  taskTab: undefined,
                  detailScrollTop: 0,
                },
          ),
        openSubtask: (threadKey, subtaskId, tab) =>
          update(threadKey, (current) => {
            if (current.subtaskId === subtaskId && (tab === undefined || tab === current.tab))
              return current;
            // The task's own tab is remembered while inside its subtasks; a subtask's tab never
            // carries back to the task.
            const taskTab = current.subtaskId === null ? current.tab : current.taskTab;
            if (subtaskId === null) {
              return {
                ...current,
                subtaskId,
                tab: tab ?? taskTab ?? current.tab,
                taskTab: undefined,
                detailScrollTop: 0,
              };
            }
            return {
              ...current,
              subtaskId,
              tab: tab ?? current.tab,
              taskTab,
              detailScrollTop: 0,
            };
          }),
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
      version: 2,
      // Version 1 entries had no `updatedAt`; they count as oldest.
      migrate: (persisted) => {
        const byThreadKey =
          (persisted as { byThreadKey?: Record<string, TasksNavigation> } | null)?.byThreadKey ??
          {};
        return {
          byThreadKey: capThreads(
            Object.fromEntries(
              Object.entries(byThreadKey).map(([key, entry]) => [key, { ...entry, updatedAt: 0 }]),
            ),
          ),
        };
      },
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

/**
 * Board lanes the user turned off: one setting for every thread and window, under its own key so
 * a toggle never writes thread navigation.
 */
export const useTasksBoardLanes = create<{
  readonly hiddenLanes: ReadonlyArray<OrbitTaskLane>;
  readonly toggleLane: (lane: OrbitTaskLane) => void;
}>()(
  persist(
    (set) => ({
      hiddenLanes: [],
      toggleLane: (lane) =>
        set((state) => ({
          hiddenLanes: state.hiddenLanes.includes(lane)
            ? state.hiddenLanes.filter((entry) => entry !== lane)
            : [...state.hiddenLanes, lane],
        })),
    }),
    {
      name: "conn:tasks-board:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ hiddenLanes: state.hiddenLanes }),
    },
  ),
);

// Another window's toggle lands in storage; read it so this window never writes a stale copy.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === "conn:tasks-board:v1") void useTasksBoardLanes.persist.rehydrate();
  });
}

/**
 * The board search, for this window's session only. Kept apart from the persisted store so typing
 * never writes navigation that another window may have changed since.
 */
export const useTasksBoardQuery = create<{
  readonly query: string;
  readonly setQuery: (query: string) => void;
}>()((set) => ({ query: "", setQuery: (query) => set({ query }) }));

/**
 * Where each lane is scrolled, per thread, for this window's session only. Lanes scroll often,
 * so their offsets stay out of the persisted store for the same reason as the search.
 */
export const useTasksLaneScroll = create<{
  readonly byThreadKey: Readonly<Record<string, Partial<Record<OrbitTaskLane, number>>>>;
  readonly save: (threadKey: string, lane: OrbitTaskLane, top: number) => void;
}>()((set) => ({
  byThreadKey: {},
  save: (threadKey, lane, top) =>
    set((state) =>
      state.byThreadKey[threadKey]?.[lane] === top
        ? state
        : {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...state.byThreadKey[threadKey], [lane]: top },
            },
          },
    ),
}));

export function useTasksNavigation(threadKey: string): TasksNavigation {
  return useTasksPanelStore((state) => state.byThreadKey[threadKey] ?? DEFAULT_TASKS_NAVIGATION);
}

/** The store's actions, for event handlers. */
export function tasksPanelActions(): TasksPanelState {
  return useTasksPanelStore.getState();
}

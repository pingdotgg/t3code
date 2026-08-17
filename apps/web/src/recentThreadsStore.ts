/**
 * Session-scoped record of the threads the user opened, most recent first.
 * Deliberately in-memory: the recent-threads switcher cycles what was
 * visited since the app loaded, not activity order or a persisted history.
 */
import { create } from "zustand";

export const MAX_RECENT_THREAD_KEYS = 50;

/**
 * Moves an opened thread key to the front. Returns the SAME array when
 * nothing changed so subscribers keyed on identity skip redundant updates.
 */
export function withRecentThreadKey(
  current: ReadonlyArray<string>,
  opened: string,
): ReadonlyArray<string> {
  if (current[0] === opened) return current;
  return [opened, ...current.filter((key) => key !== opened)].slice(0, MAX_RECENT_THREAD_KEYS);
}

interface RecentThreadsStore {
  /** Scoped thread keys in visit order, newest first. */
  recentThreadKeys: ReadonlyArray<string>;
  recordThreadVisit: (threadKey: string) => void;
}

export const useRecentThreadsStore = create<RecentThreadsStore>((set) => ({
  recentThreadKeys: [],
  recordThreadVisit: (threadKey) => {
    set((state) => {
      const next = withRecentThreadKey(state.recentThreadKeys, threadKey);
      return next === state.recentThreadKeys ? state : { recentThreadKeys: next };
    });
  },
}));

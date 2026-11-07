import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MAX_TABS = 12;

interface WorkspaceTabsState {
  /** Scoped thread keys, left to right. Per browser: each client keeps its own open set. */
  readonly keys: ReadonlyArray<string>;
  open: (key: string) => void;
  close: (key: string) => void;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set) => ({
      keys: [],
      open: (key) =>
        set((state) =>
          state.keys.includes(key) ? state : { keys: [...state.keys, key].slice(-MAX_TABS) },
        ),
      close: (key) => set((state) => ({ keys: state.keys.filter((open) => open !== key) })),
    }),
    {
      name: "t3code:workspace-tabs:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ keys: state.keys }),
    },
  ),
);

/** The tab to show after closing `key`: its right neighbor, else its left one. */
export function neighborTabKey(keys: ReadonlyArray<string>, key: string): string | null {
  const index = keys.indexOf(key);
  if (index === -1) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}

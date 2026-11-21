import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface ThreadTabsStoreState {
  /** Scoped thread keys, in tab order. */
  keys: string[];
  add: (key: string) => void;
  remove: (key: string) => void;
}

export const useThreadTabsStore = create<ThreadTabsStoreState>()(
  persist(
    (set) => ({
      keys: [],
      add: (key) =>
        set((state) => (state.keys.includes(key) ? state : { keys: [...state.keys, key] })),
      remove: (key) => set((state) => ({ keys: state.keys.filter((entry) => entry !== key) })),
    }),
    {
      name: "t3code:thread-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ keys }) => ({ keys }),
      merge: (persisted, current) => {
        const keys = (persisted as Partial<Pick<ThreadTabsStoreState, "keys">> | null)?.keys;
        return {
          ...current,
          keys: Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : [],
        };
      },
    },
  ),
);

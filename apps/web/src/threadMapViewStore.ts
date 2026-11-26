import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface ThreadMapViewStore {
  /** Threads showing the map instead of the conversation, for this session only. */
  readonly mapThreadKeys: ReadonlySet<string>;
  readonly setThreadMapShown: (ref: ScopedThreadRef, shown: boolean) => void;
}

export const useThreadMapViewStore = create<ThreadMapViewStore>((set) => ({
  mapThreadKeys: new Set(),
  setThreadMapShown: (ref, shown) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (state.mapThreadKeys.has(key) === shown) return state;
      const mapThreadKeys = new Set(state.mapThreadKeys);
      if (shown) mapThreadKeys.add(key);
      else mapThreadKeys.delete(key);
      return { mapThreadKeys };
    }),
}));

export function useThreadMapChosen(ref: ScopedThreadRef | null): boolean {
  return useThreadMapViewStore(
    (state) => ref !== null && state.mapThreadKeys.has(scopedThreadKey(ref)),
  );
}

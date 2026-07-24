import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

interface OptimisticThreadArchiveState {
  readonly threadKeys: ReadonlySet<string>;
  readonly hide: (threadRef: ScopedThreadRef) => void;
  readonly show: (threadRef: ScopedThreadRef) => void;
}

export const useOptimisticThreadArchiveStore = create<OptimisticThreadArchiveState>((set) => ({
  threadKeys: new Set(),
  hide: (threadRef) =>
    set((state) => {
      const next = new Set(state.threadKeys);
      next.add(scopedThreadKey(threadRef));
      return { threadKeys: next };
    }),
  show: (threadRef) =>
    set((state) => {
      const next = new Set(state.threadKeys);
      next.delete(scopedThreadKey(threadRef));
      return { threadKeys: next };
    }),
}));

export function optimisticallyHideArchivedThread(threadRef: ScopedThreadRef): void {
  useOptimisticThreadArchiveStore.getState().hide(threadRef);
}

export function revealOptimisticallyArchivedThread(threadRef: ScopedThreadRef): void {
  useOptimisticThreadArchiveStore.getState().show(threadRef);
}

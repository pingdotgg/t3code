import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

interface OptimisticThreadArchiveState {
  readonly threadKeys: ReadonlySet<string>;
  readonly operationCounts: ReadonlyMap<string, number>;
  readonly hide: (threadRef: ScopedThreadRef) => void;
  readonly show: (threadRef: ScopedThreadRef) => void;
}

export const useOptimisticThreadArchiveStore = create<OptimisticThreadArchiveState>((set) => ({
  threadKeys: new Set(),
  operationCounts: new Map(),
  hide: (threadRef) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const next = new Set(state.threadKeys);
      const operationCounts = new Map(state.operationCounts);
      next.add(threadKey);
      operationCounts.set(threadKey, (operationCounts.get(threadKey) ?? 0) + 1);
      return { threadKeys: next, operationCounts };
    }),
  show: (threadRef) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const next = new Set(state.threadKeys);
      const operationCounts = new Map(state.operationCounts);
      const remaining = (operationCounts.get(threadKey) ?? 0) - 1;
      if (remaining > 0) {
        operationCounts.set(threadKey, remaining);
      } else {
        operationCounts.delete(threadKey);
        next.delete(threadKey);
      }
      return { threadKeys: next, operationCounts };
    }),
}));

export function optimisticallyHideArchivedThread(threadRef: ScopedThreadRef): void {
  useOptimisticThreadArchiveStore.getState().hide(threadRef);
}

export function revealOptimisticallyArchivedThread(threadRef: ScopedThreadRef): void {
  useOptimisticThreadArchiveStore.getState().show(threadRef);
}

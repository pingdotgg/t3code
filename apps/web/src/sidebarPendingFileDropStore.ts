import { create } from "zustand";

import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * `scopedThreadKey` joins with `:`, so two distinct refs can collide when an id
 * itself contains one; drops must never cross threads on that account.
 */
export function isSameSidebarThreadRef(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

export interface SidebarPendingFileDrop {
  id: string;
  threadRef: ScopedThreadRef;
  files: File[];
}

interface SidebarPendingFileDropStoreState {
  pending: SidebarPendingFileDrop[];
  queuePendingFileDrop: (entry: Omit<SidebarPendingFileDrop, "id">) => string;
  clearPendingFileDrop: (id: string) => void;
  clearPendingFileDropsForThread: (threadRef: ScopedThreadRef) => void;
  consumePendingFileDrop: (threadRef: ScopedThreadRef) => File[] | null;
}

let nextPendingFileDropId = 0;

export const useSidebarPendingFileDropStore = create<SidebarPendingFileDropStoreState>()(
  (set, get) => ({
    pending: [],
    queuePendingFileDrop: (entry) => {
      const id = `sidebar-file-drop-${(nextPendingFileDropId += 1)}`;
      set((state) => ({ pending: [...state.pending, { ...entry, id }] }));
      return id;
    },
    clearPendingFileDrop: (id) => {
      set((state) => ({ pending: state.pending.filter((drop) => drop.id !== id) }));
    },
    clearPendingFileDropsForThread: (threadRef) => {
      set((state) => ({
        pending: state.pending.filter((drop) => !isSameSidebarThreadRef(drop.threadRef, threadRef)),
      }));
    },
    consumePendingFileDrop: (threadRef) => {
      const matches = get().pending.filter((drop) =>
        isSameSidebarThreadRef(drop.threadRef, threadRef),
      );
      if (matches.length === 0) {
        return null;
      }
      const matchedIds = new Set(matches.map((drop) => drop.id));
      set((state) => ({ pending: state.pending.filter((drop) => !matchedIds.has(drop.id)) }));
      return matches.flatMap((drop) => drop.files);
    },
  }),
);

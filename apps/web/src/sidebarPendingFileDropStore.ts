import { create } from "zustand";

import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Field-wise ref equality. `scopedThreadKey` joins with `:`, so two distinct
 * refs can collide when an id itself contains one; drops must never cross
 * threads on that account.
 */
export function isSameSidebarThreadRef(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

/**
 * One sidebar row drop. Drops queue up instead of replacing each other, so a
 * second drop onto the same thread before it opens keeps both files; each
 * entry carries its own id so a stale navigation can only ever clear the drop
 * that started it.
 */
export interface SidebarPendingFileDrop {
  id: string;
  threadRef: ScopedThreadRef;
  files: File[];
}

interface SidebarPendingFileDropStoreState {
  pending: SidebarPendingFileDrop[];
  /**
   * Appends a drop to the queue and returns its id, for later
   * identity-checked cleanup.
   */
  queuePendingFileDrop: (entry: Omit<SidebarPendingFileDrop, "id">) => string;
  /** Removes the single drop with this id, leaving newer drops untouched. */
  clearPendingFileDrop: (id: string) => void;
  /** Removes every queued drop aimed at this thread (e.g. it went missing). */
  clearPendingFileDropsForThread: (threadRef: ScopedThreadRef) => void;
  /**
   * Returns every queued drop's files for `threadRef`, oldest first, and
   * removes them; returns null (leaving state untouched) when none match.
   */
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

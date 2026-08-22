import { create } from "zustand";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Files dropped onto a sidebar thread row while another thread was open.
 * The row hands these off and navigates; ChatView attaches them through the
 * composer's normal drop path once the dropped-on thread actually becomes
 * active, so they can never land on the wrong thread's draft.
 */
export interface SidebarPendingFileDrop {
  threadRef: ScopedThreadRef;
  files: File[];
}

interface SidebarPendingFileDropStoreState {
  pending: SidebarPendingFileDrop | null;
  /** Replaces any earlier pending drop: only the latest handoff matters. */
  setPendingFileDrop: (entry: SidebarPendingFileDrop) => void;
  clearPendingFileDrop: () => void;
  /**
   * Returns the stashed files when `threadRef` matches the drop target and
   * clears the entry; returns null (leaving state untouched) otherwise.
   */
  consumePendingFileDrop: (threadRef: ScopedThreadRef) => File[] | null;
}

export const useSidebarPendingFileDropStore = create<SidebarPendingFileDropStoreState>()(
  (set, get) => ({
    pending: null,
    setPendingFileDrop: (entry) => {
      set({ pending: entry });
    },
    clearPendingFileDrop: () => {
      set({ pending: null });
    },
    consumePendingFileDrop: (threadRef) => {
      const pending = get().pending;
      if (pending === null || scopedThreadKey(pending.threadRef) !== scopedThreadKey(threadRef)) {
        return null;
      }
      set({ pending: null });
      return pending.files;
    },
  }),
);

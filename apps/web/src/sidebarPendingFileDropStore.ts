import { create } from "zustand";

import type { ScopedThreadRef } from "@t3tools/contracts";

import type { DraftId } from "./composerDraftStore";

/** Compare both ids; scopedThreadKey can collide when ids contain colons. */
function isSameSidebarThreadRef(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

/** A server thread, or a new draft started by dropping files on the sidebar. */
export type SidebarFileDropTarget = ScopedThreadRef | DraftId;

export function isSameSidebarFileDropTarget(
  a: SidebarFileDropTarget,
  b: SidebarFileDropTarget,
): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return isSameSidebarThreadRef(a, b);
}

export interface SidebarPendingFileDrop {
  id: string;
  target: SidebarFileDropTarget;
  files: File[];
}

interface SidebarPendingFileDropStoreState {
  pending: SidebarPendingFileDrop[];
  queuePendingFileDrop: (entry: Omit<SidebarPendingFileDrop, "id">) => string;
  clearPendingFileDrop: (id: string) => void;
  clearPendingFileDropsForThread: (target: SidebarFileDropTarget) => void;
  consumePendingFileDrop: (target: SidebarFileDropTarget) => File[] | null;
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
    clearPendingFileDropsForThread: (target) => {
      set((state) => ({
        pending: state.pending.filter((drop) => !isSameSidebarFileDropTarget(drop.target, target)),
      }));
    },
    consumePendingFileDrop: (target) => {
      const matches = get().pending.filter((drop) =>
        isSameSidebarFileDropTarget(drop.target, target),
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

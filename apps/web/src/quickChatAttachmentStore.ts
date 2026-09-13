import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export const useQuickChatAttachmentStore = create<{
  threadRef: ScopedThreadRef | null;
  busy: boolean;
  open: (threadRef: ScopedThreadRef) => void;
  close: () => void;
}>((set, get) => ({
  threadRef: null,
  busy: false,
  open: (threadRef) => {
    if (!get().busy) set({ threadRef });
  },
  close: () => {
    if (!get().busy) set({ threadRef: null });
  },
}));

import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface ForkThreadDialogStore {
  readonly sourceThreadRef: ScopedThreadRef | null;
  readonly setSourceThreadRef: (sourceThreadRef: ScopedThreadRef | null) => void;
}

export const useForkThreadDialogStore = create<ForkThreadDialogStore>((set) => ({
  sourceThreadRef: null,
  setSourceThreadRef: (sourceThreadRef) => set({ sourceThreadRef }),
}));

export function openForkThreadDialog(source: ScopedThreadRef): void {
  useForkThreadDialogStore.getState().setSourceThreadRef(source);
}

export function closeForkThreadDialog(): void {
  useForkThreadDialogStore.getState().setSourceThreadRef(null);
}

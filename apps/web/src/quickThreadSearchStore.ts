import { create } from "zustand";

interface QuickThreadSearchStore {
  open: boolean;
  focusRequestId: number;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useQuickThreadSearchStore = create<QuickThreadSearchStore>((set) => ({
  open: false,
  focusRequestId: 0,
  openDialog: () =>
    set((state) => ({
      open: true,
      focusRequestId: state.focusRequestId + 1,
    })),
  closeDialog: () => set({ open: false }),
}));

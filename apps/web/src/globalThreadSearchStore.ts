import { create } from "zustand";

interface GlobalThreadSearchStore {
  open: boolean;
  focusRequestId: number;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useGlobalThreadSearchStore = create<GlobalThreadSearchStore>((set) => ({
  open: false,
  focusRequestId: 0,
  openDialog: () =>
    set((state) => ({
      open: true,
      focusRequestId: state.focusRequestId + 1,
    })),
  closeDialog: () => set({ open: false }),
}));

import { create } from "zustand";

interface ProjectFolderSearchStore {
  open: boolean;
  focusRequestId: number;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useProjectFolderSearchStore = create<ProjectFolderSearchStore>((set) => ({
  open: false,
  focusRequestId: 0,
  openDialog: () =>
    set((state) => ({
      open: true,
      focusRequestId: state.focusRequestId + 1,
    })),
  closeDialog: () => set({ open: false }),
}));

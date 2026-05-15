import { create } from "zustand";

interface CommandPaletteOpenIntent {
  kind: "add-project";
  requestId: number;
}

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  checkpointRewindRequestId: number;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: () => void;
  openCheckpointRewind: () => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  checkpointRewindRequestId: 0,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openCheckpointRewind: () =>
    set((state) => ({
      open: false,
      checkpointRewindRequestId: state.checkpointRewindRequestId + 1,
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));

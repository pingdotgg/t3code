import { create } from "zustand";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

interface CommandPaletteOpenIntent {
  kind: "add-project";
  requestId: number;
  environmentId?: EnvironmentId;
  onProjectSelected?: (projectRef: ScopedProjectRef) => void;
}

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: (
    environmentId?: EnvironmentId,
    onProjectSelected?: (projectRef: ScopedProjectRef) => void,
  ) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: (environmentId, onProjectSelected) =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
        ...(environmentId ? { environmentId } : {}),
        ...(onProjectSelected ? { onProjectSelected } : {}),
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));

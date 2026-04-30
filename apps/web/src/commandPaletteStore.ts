import { create } from "zustand";

interface CommandPaletteOpenIntent {
  kind: "add-project" | "new-thread-in" | "switch-project" | "open-preview";
  requestId: number;
}

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: () => void;
  openNewThreadIn: () => void;
  openProjectSwitcher: () => void;
  openPreview: () => void;
  clearOpenIntent: () => void;
}

function nextOpenIntent(
  kind: CommandPaletteOpenIntent["kind"],
  requestId: number,
): CommandPaletteOpenIntent {
  return {
    kind,
    requestId,
  };
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: () =>
    set((state) => ({
      open: true,
      openIntent: nextOpenIntent("add-project", (state.openIntent?.requestId ?? 0) + 1),
    })),
  openNewThreadIn: () =>
    set((state) => ({
      open: true,
      openIntent: nextOpenIntent("new-thread-in", (state.openIntent?.requestId ?? 0) + 1),
    })),
  openProjectSwitcher: () =>
    set((state) => ({
      open: true,
      openIntent: nextOpenIntent("switch-project", (state.openIntent?.requestId ?? 0) + 1),
    })),
  openPreview: () =>
    set((state) => ({
      open: true,
      openIntent: nextOpenIntent("open-preview", (state.openIntent?.requestId ?? 0) + 1),
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));

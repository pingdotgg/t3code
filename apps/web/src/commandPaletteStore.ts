import type { EnvironmentId } from "@marcode/contracts";
import { create } from "zustand";

interface CommandPaletteAddProjectIntent {
  kind: "add-project";
  requestId: number;
}

interface CommandPaletteAddFolderIntent {
  kind: "add-folder";
  requestId: number;
  environmentId: EnvironmentId;
  initialPath: string;
  onConfirm: (absolutePath: string) => Promise<void>;
}

type CommandPaletteOpenIntent = CommandPaletteAddProjectIntent | CommandPaletteAddFolderIntent;

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: () => void;
  openAddFolder: (params: {
    environmentId: EnvironmentId;
    initialPath: string;
    onConfirm: (absolutePath: string) => Promise<void>;
  }) => void;
  clearOpenIntent: () => void;
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
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openAddFolder: ({ environmentId, initialPath, onConfirm }) =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-folder",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
        environmentId,
        initialPath,
        onConfirm,
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));

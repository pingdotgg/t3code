import { create } from "zustand";

/**
 * Ephemeral UI state for the "Rename worktree" dialog. The dialog is mounted
 * once globally (see WorktreeRenameDialog) so any surface — the sidebar thread
 * context menu, the bottom-bar workspace label — can open it for a given
 * worktree path. Not persisted; the labels themselves live in useUiStateStore.
 */
interface WorktreeRenameStore {
  /** Worktree path currently being renamed, or null when the dialog is closed. */
  targetPath: string | null;
  openWorktreeRename: (worktreePath: string) => void;
  closeWorktreeRename: () => void;
}

export const useWorktreeRenameStore = create<WorktreeRenameStore>((set) => ({
  targetPath: null,
  openWorktreeRename: (worktreePath) => {
    // Store the path verbatim — it's the exact key labels are written/read
    // under (see setWorktreeLabel). Ignore a blank path.
    if (worktreePath.trim().length > 0) {
      set({ targetPath: worktreePath });
    }
  },
  closeWorktreeRename: () => set({ targetPath: null }),
}));

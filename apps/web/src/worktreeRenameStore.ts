import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Ephemeral UI state for the "Rename worktree" dialog. The dialog is mounted
 * once globally (see WorktreeRenameDialog) so any surface — the sidebar thread
 * context menu, the bottom-bar workspace label — can open it for a given
 * environment-scoped worktree path. Not persisted; the labels themselves live
 * in useUiStateStore.
 */
interface WorktreeRenameStore {
  target: { environmentId: EnvironmentId; worktreePath: string } | null;
  openWorktreeRename: (environmentId: EnvironmentId, worktreePath: string) => void;
  closeWorktreeRename: () => void;
}

export const useWorktreeRenameStore = create<WorktreeRenameStore>((set) => ({
  target: null,
  openWorktreeRename: (environmentId, worktreePath) => {
    if (worktreePath.trim().length > 0) {
      set({ target: { environmentId, worktreePath } });
    }
  },
  closeWorktreeRename: () => set({ target: null }),
}));

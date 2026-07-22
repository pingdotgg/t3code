import { useCallback, type MouseEvent } from "react";

import { readLocalApi } from "../localApi";
import { useWorktreeRenameStore } from "../worktreeRenameStore";

export interface WorktreeRenameTriggerHandlers {
  onDoubleClick: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
}

/**
 * Shared interaction handlers for renaming the active worktree from a label
 * surface (e.g. the bottom-bar workspace label). Double-click opens the rename
 * dialog directly; right-click shows a native "Rename worktree" context menu.
 * Both are no-ops when the thread isn't on a worktree, so they're safe to wire
 * unconditionally. The rename is a cosmetic label only — no disk move.
 */
export function useWorktreeRenameTrigger(
  activeWorktreePath: string | null,
): WorktreeRenameTriggerHandlers {
  const openWorktreeRename = useWorktreeRenameStore((state) => state.openWorktreeRename);

  const onDoubleClick = useCallback(
    (event: MouseEvent) => {
      if (!activeWorktreePath) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openWorktreeRename(activeWorktreePath);
    },
    [activeWorktreePath, openWorktreeRename],
  );

  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      if (!activeWorktreePath) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Capture coordinates before the await — the event may be reused.
      const position = { x: event.clientX, y: event.clientY };
      const api = readLocalApi();
      if (!api) {
        // No native context menu available; open the dialog directly.
        openWorktreeRename(activeWorktreePath);
        return;
      }
      void api.contextMenu
        .show([{ id: "rename-worktree", label: "Rename worktree" }], position)
        .then((clicked) => {
          if (clicked === "rename-worktree") {
            openWorktreeRename(activeWorktreePath);
          }
        });
    },
    [activeWorktreePath, openWorktreeRename],
  );

  return { onDoubleClick, onContextMenu };
}

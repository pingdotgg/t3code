import type { EnvironmentId, LocalApi } from "@t3tools/contracts";
import { useCallback, type MouseEvent } from "react";

import { readLocalApi } from "../localApi";
import { useWorktreeRenameStore } from "../worktreeRenameStore";

export interface WorktreeRenameTriggerHandlers {
  onDoubleClick: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
}

export async function shouldOpenWorktreeRenameFromContextMenu(
  contextMenu: LocalApi["contextMenu"],
  position: { x: number; y: number },
): Promise<boolean> {
  try {
    return (
      (await contextMenu.show([{ id: "rename-worktree", label: "Rename worktree" }], position)) ===
      "rename-worktree"
    );
  } catch {
    return true;
  }
}

/**
 * Shared interaction handlers for renaming the active worktree from a label
 * surface (e.g. the bottom-bar workspace label). Double-click opens the rename
 * dialog directly; right-click shows a native "Rename worktree" context menu.
 * Both are no-ops when the thread isn't on a worktree, so they're safe to wire
 * unconditionally. The rename is a cosmetic label only — no disk move.
 */
export function useWorktreeRenameTrigger(
  environmentId: EnvironmentId,
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
      openWorktreeRename(environmentId, activeWorktreePath);
    },
    [activeWorktreePath, environmentId, openWorktreeRename],
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
        openWorktreeRename(environmentId, activeWorktreePath);
        return;
      }
      void shouldOpenWorktreeRenameFromContextMenu(api.contextMenu, position).then((shouldOpen) => {
        if (shouldOpen) {
          openWorktreeRename(environmentId, activeWorktreePath);
        }
      });
    },
    [activeWorktreePath, environmentId, openWorktreeRename],
  );

  return { onDoubleClick, onContextMenu };
}

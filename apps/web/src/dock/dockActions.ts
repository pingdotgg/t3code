import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import type { DockDropTarget } from "./dockDrop";
import { DEFAULT_DOCK_NODE_SIZE } from "./dockLayout";
import { resolveSurfaceGroupId, useDockLayoutStore } from "./dockLayoutStore";

const EXPLORER_WIDTH = 280;

function pruneDock() {
  const pinnedGroupIds = Object.values(useRightPanelStore.getState().byThreadKey).flatMap(
    (thread) => thread.surfaces.flatMap((surface) => (surface.groupId ? [surface.groupId] : [])),
  );
  useDockLayoutStore.getState().prune(pinnedGroupIds);
}

export function applyDockDrop(
  threadRef: ScopedThreadRef,
  surfaceId: string,
  target: DockDropTarget,
) {
  const dock = useDockLayoutStore.getState();
  const groupId = target.type === "tabs" ? target.groupId : dock.createGroup(target);
  useRightPanelStore
    .getState()
    .placeSurface(threadRef, surfaceId, groupId, target.type === "tabs" ? target.index : null);
  pruneDock();
}

/** Back to the chat and one panel. Tabs stay open and fall back to the panel. */
export function resetDockLayout() {
  useDockLayoutStore.getState().resetLayout();
}

/**
 * Opens a file picked in the files surface. Until the user has placed file tabs, the first one
 * splits beside the tree, so picking a file does not cover the list it was picked from.
 */
export function openFileFromExplorer(threadRef: ScopedThreadRef, relativePath: string) {
  const dock = useDockLayoutStore.getState();
  const panels = useRightPanelStore.getState();
  const explorer = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
    (surface) => surface.kind === "files",
  );
  if (explorer && dock.kindGroups.file === undefined) {
    const explorerGroupId = resolveSurfaceGroupId(explorer, dock);
    if (explorerGroupId === resolveSurfaceGroupId({ kind: "file" }, dock)) {
      const groupId = dock.createGroup({
        type: "split",
        nodeId: explorerGroupId,
        edge: "left",
        size: DEFAULT_DOCK_NODE_SIZE,
      });
      // The split's half would leave a tree too narrow to read, so it keeps a usable width.
      dock.setNodeSizes({ [explorerGroupId]: EXPLORER_WIDTH });
      dock.setKindGroup("file", groupId);
    }
  }
  panels.openFile(threadRef, relativePath);
}

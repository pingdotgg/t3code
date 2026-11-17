import { useState, type DragEvent } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { orderSidebarProjectFolders } from "../Sidebar.logic";

// Native drag, so it stays clear of the dnd-kit pointer drags thread rows use.
const FOLDER_DRAG_TYPE = "application/x-t3code-project-folder";

export type ProjectFolderDropEdge = "before" | "after";

function memberOrderKeys(group: SidebarProjectSnapshot): string[] {
  return group.memberProjects.map((member) => member.physicalProjectKey);
}

/** Boring-sidebar folder order, and dragging a folder header to change it. */
export function useProjectFolderOrder(groups: readonly SidebarProjectSnapshot[]) {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const [drag, setDrag] = useState<{ key: string; overKey: string | null } | null>(null);
  const orderedGroups = orderSidebarProjectFolders(groups, projectOrder);
  const indexOf = (key: string) => orderedGroups.findIndex((group) => group.projectKey === key);
  const dragged = drag === null ? undefined : orderedGroups[indexOf(drag.key)];
  // Pinned projects lead and archived ones trail, so a folder moves only among its peers.
  const canDrop = (target: SidebarProjectSnapshot) =>
    dragged !== undefined &&
    dragged.projectKey !== target.projectKey &&
    !target.archived &&
    dragged.pinned === target.pinned;

  const dropEdge = (target: SidebarProjectSnapshot): ProjectFolderDropEdge | null => {
    if (drag === null || drag.overKey !== target.projectKey || !canDrop(target)) return null;
    return indexOf(drag.key) < indexOf(target.projectKey) ? "after" : "before";
  };

  const onDragStart = useStableCallback((group: SidebarProjectSnapshot, event: DragEvent) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(FOLDER_DRAG_TYPE, group.projectKey);
    setDrag({ key: group.projectKey, overKey: null });
  });
  const onDragOver = useStableCallback((group: SidebarProjectSnapshot, event: DragEvent) => {
    if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE) || !canDrop(group)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (drag?.overKey !== group.projectKey) {
      setDrag((current) => (current === null ? null : { ...current, overKey: group.projectKey }));
    }
  });
  const onDragLeave = useStableCallback((group: SidebarProjectSnapshot, event: DragEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDrag((current) =>
      current?.overKey === group.projectKey ? { ...current, overKey: null } : current,
    );
  });
  const onDrop = useStableCallback((group: SidebarProjectSnapshot, event: DragEvent) => {
    if (dragged === undefined || !canDrop(group)) return;
    event.preventDefault();
    setDrag(null);
    reorderProjects(
      orderedGroups.flatMap(memberOrderKeys),
      memberOrderKeys(dragged),
      memberOrderKeys(group),
    );
  });
  const onDragEnd = useStableCallback(() => setDrag(null));

  return {
    orderedGroups,
    draggedKey: drag?.key ?? null,
    dropEdge,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
  };
}

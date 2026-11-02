import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";
import { dockGroupIds, resolveSurfaceGroupId, type DockLayout } from "./dockLayoutStore";
import {
  CHAT_GROUP_ID,
  PANEL_GROUP_ID,
  resolveDockTitlebarEdges,
  type DockTitlebarEdges,
} from "./dockLayout";

export interface DockGroupView {
  readonly id: string;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurface: RightPanelSurface | null;
  readonly launcher: boolean;
}

export interface DockView {
  readonly root: DockLayout["root"];
  readonly groups: ReadonlyMap<string, DockGroupView>;
  readonly edges: DockTitlebarEdges;
  /** The group that takes over the workspace while the thread's panel is maximized. */
  readonly maximizedGroupId: string | null;
}

/** The surface a group shows for a thread: its recorded tab, or else its newest. */
export function resolveGroupActiveSurface(
  thread: ThreadRightPanelState,
  groupId: string,
  layout: DockLayout,
): RightPanelSurface | null {
  const surfaces = thread.surfaces.filter(
    (surface) => resolveSurfaceGroupId(surface, layout) === groupId,
  );
  const recorded = thread.activeGroupTabs?.[groupId];
  return surfaces.find((surface) => surface.id === recorded) ?? surfaces.at(-1) ?? null;
}

/**
 * What the workspace shows for one thread. A group with nothing to show drops out, so a thread
 * without a terminal open does not reserve the terminal's pane. `threadsSide` is the window edge
 * the threads sidebar is showing on, which takes that title bar corner from the dock.
 */
export function resolveDockView(input: {
  readonly layout: DockLayout;
  readonly thread: ThreadRightPanelState | null;
  readonly threadsSide: "left" | "right" | null;
}): DockView {
  const { layout, thread, threadsSide } = input;
  const hidden = new Set(thread?.hiddenGroupIds);
  const surfacesByGroup = new Map<string, RightPanelSurface[]>();
  if (thread?.isOpen) {
    for (const surface of thread.surfaces) {
      const groupId = resolveSurfaceGroupId(surface, layout);
      if (hidden.has(groupId)) continue;
      surfacesByGroup.set(groupId, [...(surfacesByGroup.get(groupId) ?? []), surface]);
    }
  }
  const launcher = thread?.isOpen === true && thread.surfaces.length === 0;
  const groups = new Map<string, DockGroupView>();
  for (const id of dockGroupIds(layout.root)) {
    const surfaces = surfacesByGroup.get(id) ?? [];
    const showsLauncher = launcher && id === PANEL_GROUP_ID;
    if (id !== CHAT_GROUP_ID && surfaces.length === 0 && !showsLauncher) continue;
    const activeSurface =
      surfaces.length > 0 && thread ? resolveGroupActiveSurface(thread, id, layout) : null;
    groups.set(id, { id, surfaces, activeSurface, launcher: showsLauncher });
  }
  const edges = resolveDockTitlebarEdges(layout.root, new Set(groups.keys()));
  const active = thread?.surfaces.find((surface) => surface.id === thread.activeSurfaceId);
  return {
    root: layout.root,
    groups,
    edges: {
      top: edges.top,
      left: threadsSide === "left" ? null : edges.left,
      right: threadsSide === "right" ? null : edges.right,
    },
    maximizedGroupId:
      thread?.isOpen && thread.maximized && active ? resolveSurfaceGroupId(active, layout) : null,
  };
}

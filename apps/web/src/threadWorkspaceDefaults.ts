import { getPanes } from "./splitPaneTree";
import {
  migratePersistedRightPanelState,
  type RightPanelSurface,
  type ThreadRightPanelState,
} from "./rightPanelStore";
import {
  parsePersistedThreadWorkspaceTabFields,
  transitionThreadWorkspaceTabs,
  type ThreadWorkspaceTabFields,
} from "./threadWorkspaceTabs";

export interface ThreadWorkspaceDefault {
  readonly layout: ThreadWorkspaceTabFields;
  readonly rightPanel: ThreadRightPanelState;
}

const PARSE_KEY = "workspace-default";

function reusableDefaultSurface(
  surface: RightPanelSurface,
  terminalSequence: number,
  singletonKinds: Set<"preview" | "device">,
): RightPanelSurface | null {
  switch (surface.kind) {
    case "diff":
    case "files":
    case "pull-requests":
    case "agents":
      return surface;
    case "preview":
      if (singletonKinds.has("preview")) return null;
      singletonKinds.add("preview");
      return { id: "browser:new", kind: "preview", resourceId: null };
    case "device":
      if (singletonKinds.has("device")) return null;
      singletonKinds.add("device");
      return { id: "device", kind: "device" };
    case "terminal": {
      const baseId = `workspace-${terminalSequence}`;
      const terminalIds = surface.terminalIds.map((_, index) =>
        index === 0 ? baseId : `${baseId}-${index + 1}`,
      );
      const activeIndex = Math.max(0, surface.terminalIds.indexOf(surface.activeTerminalId));
      const activeTerminalId = terminalIds[activeIndex] ?? terminalIds[0] ?? baseId;
      return {
        id: `terminal:${baseId}`,
        kind: "terminal",
        resourceId: baseId,
        terminalIds: terminalIds.length > 0 ? terminalIds : [activeTerminalId],
        activeTerminalId,
        ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
      };
    }
    case "file":
    case "pull-request":
      return null;
  }
}

function closeEmptyDefaultPanes(layout: ThreadWorkspaceTabFields): ThreadWorkspaceTabFields {
  let next = layout;
  while (next.paneTree.root._tag === "Split") {
    const emptyPane = getPanes(next.paneTree.root).find((pane) => pane.tabIds.length === 0);
    if (!emptyPane) break;
    const closed = transitionThreadWorkspaceTabs(next, {
      _tag: "CloseEmptyPane",
      paneId: emptyPane.id,
    });
    if (closed === next) break;
    next = closed;
  }
  return next;
}

/** Captures only resources that can be recreated safely for a different thread. */
export function createThreadWorkspaceDefault(
  layout: ThreadWorkspaceTabFields,
  rightPanel: ThreadRightPanelState,
): ThreadWorkspaceDefault {
  const singletonKinds = new Set<"preview" | "device">();
  const surfaceIdMap = new Map<string, string>();
  const surfaces: RightPanelSurface[] = [];
  let terminalSequence = 0;

  for (const surface of rightPanel.surfaces) {
    if (surface.kind === "terminal") terminalSequence += 1;
    const reusable = reusableDefaultSurface(surface, terminalSequence, singletonKinds);
    if (!reusable) continue;
    surfaceIdMap.set(surface.id, reusable.id);
    surfaces.push(reusable);
  }

  let reusableLayout = layout;
  for (const [previousSurfaceId, nextSurfaceId] of surfaceIdMap) {
    reusableLayout = transitionThreadWorkspaceTabs(reusableLayout, {
      _tag: "ReplaceSurfaceTabs",
      previousSurfaceId,
      nextSurfaceId,
    });
  }
  reusableLayout = transitionThreadWorkspaceTabs(reusableLayout, {
    _tag: "ReconcileSurfaceTabs",
    surfaceIds: surfaces.map((surface) => surface.id),
  });
  reusableLayout = closeEmptyDefaultPanes(reusableLayout);
  reusableLayout = {
    ...reusableLayout,
    paneTree: { ...reusableLayout.paneTree, maximizedPaneId: null },
  };

  const activeSurfaceId = rightPanel.activeSurfaceId
    ? (surfaceIdMap.get(rightPanel.activeSurfaceId) ?? null)
    : null;
  return {
    layout: reusableLayout,
    rightPanel: {
      isOpen: rightPanel.isOpen && surfaces.length > 0,
      surfaces,
      activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? null,
    },
  };
}

export function parseThreadWorkspaceDefault(input: unknown): ThreadWorkspaceDefault | null {
  if (!input || typeof input !== "object" || !("layout" in input) || !("rightPanel" in input)) {
    return null;
  }
  const layout = parsePersistedThreadWorkspaceTabFields(input.layout);
  if (!layout) return null;
  const parsedPanels = migratePersistedRightPanelState({
    byThreadKey: { [PARSE_KEY]: input.rightPanel },
  });
  const rightPanel = parsedPanels.byThreadKey[PARSE_KEY];
  if (!rightPanel) {
    return createThreadWorkspaceDefault(layout, {
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  }
  return createThreadWorkspaceDefault(layout, rightPanel);
}

export function describeThreadWorkspaceDefault(template: ThreadWorkspaceDefault): string {
  const paneCount = getPanes(template.layout.paneTree.root).length;
  const surfaceCount = template.rightPanel.surfaces.length;
  return `${paneCount} ${paneCount === 1 ? "pane" : "panes"}, ${surfaceCount} ${surfaceCount === 1 ? "tool" : "tools"}`;
}

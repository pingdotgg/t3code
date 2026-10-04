export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";

export type ThreadPanelPresentation = "inline" | "popover";

/** Layout references surfaces only. It never owns a file, browser, PTY, or agent. */
export type WorkspacePane =
  | { type: "group"; id: string; tabs: string[]; active: string }
  | {
      type: "split";
      id: string;
      axis: "horizontal" | "vertical";
      ratio: number;
      first: WorkspacePane;
      second: WorkspacePane;
    };
export type PaneEdge = "left" | "right" | "top" | "bottom";
export const CONVERSATION_SURFACE = "conversation";
export const paneGroups = (pane: WorkspacePane): Extract<WorkspacePane, { type: "group" }>[] =>
  pane.type === "group" ? [pane] : [...paneGroups(pane.first), ...paneGroups(pane.second)];
export function defaultWorkspaceLayout(
  surfaces: readonly string[],
  active?: string | null,
): WorkspacePane {
  const conversation: WorkspacePane = {
    type: "group",
    id: "conversation-pane",
    tabs: [CONVERSATION_SURFACE],
    active: CONVERSATION_SURFACE,
  };
  return surfaces.length
    ? {
        type: "split",
        id: "workspace-root",
        axis: "horizontal",
        ratio: 0.55,
        first: conversation,
        second: {
          type: "group",
          id: "tools-pane",
          tabs: [...surfaces],
          active: active && surfaces.includes(active) ? active : surfaces[0]!,
        },
      }
    : conversation;
}
export function restoreWorkspaceLayout(
  value: unknown,
  surfaces: readonly string[],
  active?: string | null,
): WorkspacePane {
  const allowed = new Set([CONVERSATION_SURFACE, ...surfaces]);
  const used = new Set<string>();
  const ids = new Set<string>();
  function read(candidate: unknown, depth: number): WorkspacePane | null {
    if (depth > 12 || !candidate || typeof candidate !== "object") return null;
    const node = candidate as Record<string, unknown>;
    if (typeof node.id !== "string" || ids.has(node.id)) return null;
    ids.add(node.id);
    if (node.type === "group" && Array.isArray(node.tabs)) {
      const tabs = node.tabs.filter(
        (tab): tab is string =>
          typeof tab === "string" && allowed.has(tab) && !used.has(tab) && !!used.add(tab),
      );
      return tabs.length
        ? {
            type: "group",
            id: node.id,
            tabs,
            active:
              typeof node.active === "string" && tabs.includes(node.active)
                ? node.active
                : tabs[0]!,
          }
        : null;
    }
    if (node.type !== "split" || (node.axis !== "horizontal" && node.axis !== "vertical"))
      return null;
    const first = read(node.first, depth + 1);
    const second = read(node.second, depth + 1);
    if (!first || !second) return first ?? second;
    return {
      type: "split",
      id: node.id,
      axis: node.axis,
      ratio:
        typeof node.ratio === "number" && Number.isFinite(node.ratio)
          ? Math.min(0.85, Math.max(0.15, node.ratio))
          : 0.5,
      first,
      second,
    };
  }
  let layout = read(value, 0);
  if (!layout) return defaultWorkspaceLayout(surfaces, active);
  if (!used.has(CONVERSATION_SURFACE)) return defaultWorkspaceLayout(surfaces, active);
  const missing = surfaces.filter((id) => !used.has(id));
  if (missing.length) {
    const target =
      paneGroups(layout).find((pane) => !pane.tabs.includes(CONVERSATION_SURFACE)) ??
      paneGroups(layout)[0]!;
    layout = mapWorkspacePane(layout, (node) =>
      node.id === target.id && node.type === "group"
        ? { ...node, tabs: [...node.tabs, ...missing], active: missing.at(-1)! }
        : node,
    );
  }
  return layout;
}
export function mapWorkspacePane(
  node: WorkspacePane,
  map: (node: WorkspacePane) => WorkspacePane,
): WorkspacePane {
  return map(
    node.type === "split"
      ? {
          ...node,
          first: mapWorkspacePane(node.first, map),
          second: mapWorkspacePane(node.second, map),
        }
      : node,
  );
}
export function activateWorkspaceSurface(node: WorkspacePane, surfaceId: string): WorkspacePane {
  return mapWorkspacePane(node, (pane) =>
    pane.type === "group" && pane.tabs.includes(surfaceId) && pane.active !== surfaceId
      ? { ...pane, active: surfaceId }
      : pane,
  );
}
export function moveWorkspaceSurface(
  layout: WorkspacePane,
  surface: string,
  targetId: string,
  edge?: PaneEdge,
  newId = `pane:${surface}`,
): WorkspacePane {
  const groups = paneGroups(layout);
  const from = groups.find((pane) => pane.tabs.includes(surface));
  const to = groups.find((pane) => pane.id === targetId);
  if (!from || !to || (from === to && (!edge || from.tabs.length < 2)))
    return activateWorkspaceSurface(layout, surface);
  function move(node: WorkspacePane): WorkspacePane | null {
    if (node.type === "split") {
      const first = move(node.first);
      const second = move(node.second);
      return first && second ? { ...node, first, second } : (first ?? second);
    }
    const tabs = node.tabs.filter((id) => id !== surface);
    const remaining: WorkspacePane = {
      ...node,
      tabs,
      active: tabs.includes(node.active) ? node.active : (tabs[0] ?? ""),
    };
    if (node.id === targetId) {
      if (!edge) return { ...remaining, tabs: [...tabs, surface], active: surface };
      const added: WorkspacePane = { type: "group", id: newId, tabs: [surface], active: surface };
      if (!tabs.length) return added;
      return {
        type: "split",
        id: `split:${newId}`,
        axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
        ratio: 0.5,
        first: edge === "left" || edge === "top" ? added : remaining,
        second: edge === "left" || edge === "top" ? remaining : added,
      };
    }
    return tabs.length ? remaining : null;
  }
  return move(layout) ?? layout;
}
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function workspacePaneRects(
  node: WorkspacePane,
  rect: PaneRect = { x: 0, y: 0, width: 100, height: 100 },
): { node: WorkspacePane; rect: PaneRect }[] {
  if (node.type === "group") return [{ node, rect }];
  const horizontal = node.axis === "horizontal";
  const first = {
    ...rect,
    width: horizontal ? rect.width * node.ratio : rect.width,
    height: horizontal ? rect.height : rect.height * node.ratio,
  };
  const second = {
    x: horizontal ? rect.x + first.width : rect.x,
    y: horizontal ? rect.y : rect.y + first.height,
    width: horizontal ? rect.width - first.width : rect.width,
    height: horizontal ? rect.height : rect.height - first.height,
  };
  return [
    { node, rect },
    ...workspacePaneRects(node.first, first),
    ...workspacePaneRects(node.second, second),
  ];
}

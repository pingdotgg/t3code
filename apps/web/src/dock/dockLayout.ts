export type DockDirection = "row" | "column";
export type DockEdge = "left" | "right" | "top" | "bottom";

export interface DockGroupNode {
  readonly kind: "group";
  readonly id: string;
  /** Pixels along the parent split. The split's elastic child ignores it and takes the rest. */
  readonly size?: number;
}

export interface DockSplitNode {
  readonly kind: "split";
  readonly id: string;
  readonly direction: DockDirection;
  readonly children: readonly DockNode[];
  readonly size?: number;
}

export type DockNode = DockGroupNode | DockSplitNode;

export const CHAT_GROUP_ID = "chat";
export const PANEL_GROUP_ID = "panel";

export const DEFAULT_DOCK_NODE_SIZE = 520;
export const DOCK_GROUP_MIN_SIZE = 160;

export function createDefaultDockTree(): DockSplitNode {
  return {
    kind: "split",
    id: "root",
    direction: "row",
    children: [
      { kind: "group", id: CHAT_GROUP_ID },
      { kind: "group", id: PANEL_GROUP_ID, size: DEFAULT_DOCK_NODE_SIZE },
    ],
  };
}

export function edgeDirection(edge: DockEdge): DockDirection {
  return edge === "left" || edge === "right" ? "row" : "column";
}

const isLeadingEdge = (edge: DockEdge) => edge === "left" || edge === "top";

export function collectDockGroupIds(node: DockNode): string[] {
  return node.kind === "group" ? [node.id] : node.children.flatMap(collectDockGroupIds);
}

export function dockNodeContainsGroup(node: DockNode, groupId: string): boolean {
  return node.kind === "group"
    ? node.id === groupId
    : node.children.some((child) => dockNodeContainsGroup(child, groupId));
}

export function isDockNodeVisible(node: DockNode, visibleGroupIds: ReadonlySet<string>): boolean {
  return node.kind === "group"
    ? visibleGroupIds.has(node.id)
    : node.children.some((child) => isDockNodeVisible(child, visibleGroupIds));
}

/** Places `newGroupId` on one edge of a node, wrapping it in a split unless one already fits. */
export function insertGroupBeside(
  root: DockNode,
  targetNodeId: string,
  newGroupId: string,
  edge: DockEdge,
  size: number,
): DockNode {
  const direction = edgeDirection(edge);
  const inserted: DockGroupNode = { kind: "group", id: newGroupId, size };
  const placed = (target: DockNode): readonly DockNode[] =>
    isLeadingEdge(edge) ? [inserted, target] : [target, inserted];
  const visit = (node: DockNode): DockNode => {
    if (node.id === targetNodeId) {
      const { size: outerSize, ...target } = node;
      return {
        kind: "split",
        id: `split-${newGroupId}`,
        direction,
        children: placed(target),
        ...(outerSize === undefined ? {} : { size: outerSize }),
      };
    }
    if (node.kind === "group") return node;
    if (node.direction === direction) {
      const index = node.children.findIndex((child) => child.id === targetNodeId);
      const target = node.children[index];
      if (target) {
        const shrunk: DockNode =
          target.size === undefined
            ? target
            : { ...target, size: Math.max(DOCK_GROUP_MIN_SIZE, target.size - size) };
        return {
          ...node,
          children: [
            ...node.children.slice(0, index),
            ...placed(shrunk),
            ...node.children.slice(index + 1),
          ],
        };
      }
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/** Places `newGroupId` along one whole edge of the workspace. */
export function insertGroupAtRoot(
  root: DockNode,
  newGroupId: string,
  edge: DockEdge,
  size: number,
): DockNode {
  const direction = edgeDirection(edge);
  const inserted: DockGroupNode = { kind: "group", id: newGroupId, size };
  const children: readonly DockNode[] =
    root.kind === "split" && root.direction === direction ? root.children : [root];
  return {
    kind: "split",
    id: root.kind === "split" && root.direction === direction ? root.id : `root-${newGroupId}`,
    direction,
    children: isLeadingEdge(edge) ? [inserted, ...children] : [...children, inserted],
  };
}

/** Drops groups outside `keep`, then folds splits that no longer divide anything. */
export function pruneDockTree(root: DockNode, keep: ReadonlySet<string>): DockNode {
  const visit = (node: DockNode): DockNode | null => {
    if (node.kind === "group") return keep.has(node.id) ? node : null;
    const children = node.children.flatMap((child): readonly DockNode[] => {
      const next = visit(child);
      if (next === null) return [];
      return next.kind === "split" && next.direction === node.direction ? next.children : [next];
    });
    const only = children.length === 1 ? children[0] : undefined;
    if (children.length === 0) return null;
    if (!only) return { ...node, children };
    const { size: _size, ...rest } = only;
    return { ...rest, ...(node.size === undefined ? {} : { size: node.size }) };
  };
  return visit(root) ?? root;
}

export function setDockNodeSizes(
  root: DockNode,
  sizes: Readonly<Record<string, number>>,
): DockNode {
  const visit = (node: DockNode): DockNode => {
    const size = sizes[node.id];
    const sized = size === undefined ? node : { ...node, size };
    return sized.kind === "group" ? sized : { ...sized, children: sized.children.map(visit) };
  };
  return visit(root);
}

/** The one child of a split that absorbs window resizes: the chat's, or else the last. */
export function dockElasticChild(children: readonly DockNode[]): DockNode | undefined {
  return children.find((child) => dockNodeContainsGroup(child, CHAT_GROUP_ID)) ?? children.at(-1);
}

export interface DockTitlebarEdges {
  readonly top: ReadonlySet<string>;
  readonly left: string | null;
  readonly right: string | null;
}

/** Which visible groups sit under the window's title bar and its corner controls. */
export function resolveDockTitlebarEdges(
  root: DockNode,
  visibleGroupIds: ReadonlySet<string>,
): DockTitlebarEdges {
  const top = new Set<string>();
  let left: string | null = null;
  let right: string | null = null;
  const visit = (node: DockNode, leftmost: boolean, rightmost: boolean) => {
    if (node.kind === "group") {
      top.add(node.id);
      if (leftmost) left = node.id;
      if (rightmost) right = node.id;
      return;
    }
    const visible = node.children.filter((child) => isDockNodeVisible(child, visibleGroupIds));
    if (node.direction === "column") {
      const first = visible[0];
      if (first) visit(first, leftmost, rightmost);
      return;
    }
    visible.forEach((child, index) =>
      visit(child, leftmost && index === 0, rightmost && index === visible.length - 1),
    );
  };
  if (isDockNodeVisible(root, visibleGroupIds)) visit(root, true, true);
  return { top, left, right };
}

function isDockNode(value: unknown): value is DockNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<Omit<DockSplitNode, "kind">> & { kind?: unknown };
  if (typeof node.id !== "string" || (node.size !== undefined && typeof node.size !== "number")) {
    return false;
  }
  if (node.kind === "group") return true;
  return (
    node.kind === "split" &&
    (node.direction === "row" || node.direction === "column") &&
    Array.isArray(node.children) &&
    node.children.every(isDockNode)
  );
}

/** Persisted layouts come from an older build or another tab, so nothing about them is assumed. */
export function parseDockTree(value: unknown): DockNode | null {
  if (!isDockNode(value)) return null;
  const ids = collectDockGroupIds(value);
  return new Set(ids).size === ids.length ? value : null;
}

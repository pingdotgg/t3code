import {
  DOCK_GROUP_MIN_SIZE,
  edgeDirection,
  type DockDirection,
  type DockEdge,
} from "./dockLayout";

export interface DockRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface DockGroupGeometry {
  readonly id: string;
  readonly rect: DockRect;
  /** A group that keeps its content to itself: panels split around it but never tab into it. */
  readonly sealed?: boolean;
  readonly tabbar: DockRect | null;
  /** Reorderable tabs in strip order, so a drop can land between them. */
  readonly tabs: readonly { readonly id: string; readonly rect: DockRect }[];
}

/** A split below the root with two or more panels showing, which a drop can sit beside as one. */
export interface DockStackGeometry {
  readonly id: string;
  readonly direction: DockDirection;
  readonly rect: DockRect;
}

export type DockDropTarget =
  | { readonly type: "tabs"; readonly groupId: string; readonly index: number | null }
  | {
      readonly type: "split";
      readonly nodeId: string;
      readonly edge: DockEdge;
      readonly size: number;
    }
  | { readonly type: "root"; readonly edge: DockEdge; readonly size: number };

export interface DockDropResolution {
  readonly target: DockDropTarget;
  readonly preview: DockRect;
}

const ROOT_EDGE_HIT_PX = 10;
const ROOT_EDGE_SHARE = 0.25;
const GROUP_EDGE_SHARE = 0.28;
const STACK_EDGE_HIT_PX = 24;

const contains = (rect: DockRect, x: number, y: number) =>
  x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;

function edgeSlice(rect: DockRect, edge: DockEdge, size: number): DockRect {
  switch (edge) {
    case "left":
      return { ...rect, width: size };
    case "right":
      return { ...rect, left: rect.left + rect.width - size, width: size };
    case "top":
      return { ...rect, height: size };
    case "bottom":
      return { ...rect, top: rect.top + rect.height - size, height: size };
  }
}

function rootEdgeAt(root: DockRect, x: number, y: number): DockEdge | null {
  if (x - root.left <= ROOT_EDGE_HIT_PX) return "left";
  if (root.left + root.width - x <= ROOT_EDGE_HIT_PX) return "right";
  if (y - root.top <= ROOT_EDGE_HIT_PX) return "top";
  if (root.top + root.height - y <= ROOT_EDGE_HIT_PX) return "bottom";
  return null;
}

function groupEdgeAt(rect: DockRect, x: number, y: number): DockEdge | null {
  const distances: readonly (readonly [DockEdge, number])[] = [
    ["left", (x - rect.left) / rect.width],
    ["right", (rect.left + rect.width - x) / rect.width],
    ["top", (y - rect.top) / rect.height],
    ["bottom", (rect.top + rect.height - y) / rect.height],
  ];
  const nearest = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return nearest[1] <= GROUP_EDGE_SHARE ? nearest[0] : null;
}

/** The side edge of a stack, so a drop there spans every panel in it rather than one. */
function stackEdgeAt(stack: DockStackGeometry, x: number, y: number): DockEdge | null {
  const { rect } = stack;
  if (!contains(rect, x, y)) return null;
  if (stack.direction === "column") {
    if (x - rect.left <= STACK_EDGE_HIT_PX) return "left";
    return rect.left + rect.width - x <= STACK_EDGE_HIT_PX ? "right" : null;
  }
  if (y - rect.top <= STACK_EDGE_HIT_PX) return "top";
  return rect.top + rect.height - y <= STACK_EDGE_HIT_PX ? "bottom" : null;
}

function tabInsertIndex(group: DockGroupGeometry, x: number): number | null {
  if (group.tabs.length === 0) return null;
  const index = group.tabs.findIndex((tab) => x < tab.rect.left + tab.rect.width / 2);
  return index === -1 ? group.tabs.length : index;
}

/**
 * Maps a pointer to what a drop would do. Dropping a group's only tab on that group's own edge
 * would rebuild the same layout, so it resolves to nothing.
 */
export function resolveDockDrop(input: {
  readonly x: number;
  readonly y: number;
  readonly root: DockRect;
  readonly groups: readonly DockGroupGeometry[];
  readonly stacks: readonly DockStackGeometry[];
  readonly sourceGroupId: string;
  readonly sourceTabCount: number;
}): DockDropResolution | null {
  const { x, y, root, groups } = input;
  if (!contains(root, x, y)) return null;
  const group = groups.find((entry) => contains(entry.rect, x, y));
  if (group?.tabbar && contains(group.tabbar, x, y)) {
    return {
      target: { type: "tabs", groupId: group.id, index: tabInsertIndex(group, x) },
      preview: group.tabbar,
    };
  }
  const rootEdge = rootEdgeAt(root, x, y);
  if (rootEdge) {
    const extent = edgeDirection(rootEdge) === "row" ? root.width : root.height;
    const size = Math.max(DOCK_GROUP_MIN_SIZE, Math.round(extent * ROOT_EDGE_SHARE));
    return {
      target: { type: "root", edge: rootEdge, size },
      preview: edgeSlice(root, rootEdge, size),
    };
  }
  const stackHit = input.stacks
    .filter((stack) => stackEdgeAt(stack, x, y) !== null)
    .toSorted((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
  const stackEdge = stackHit ? stackEdgeAt(stackHit, x, y) : null;
  if (stackHit && stackEdge) {
    const extent = edgeDirection(stackEdge) === "row" ? stackHit.rect.width : stackHit.rect.height;
    const size = Math.max(DOCK_GROUP_MIN_SIZE, Math.round(extent / 2));
    return {
      target: { type: "split", nodeId: stackHit.id, edge: stackEdge, size },
      preview: edgeSlice(stackHit.rect, stackEdge, size),
    };
  }
  if (!group) return null;
  const alone = group.id === input.sourceGroupId && input.sourceTabCount <= 1;
  const edge = groupEdgeAt(group.rect, x, y);
  if (edge === null) {
    if (group.id === input.sourceGroupId || group.sealed) return null;
    return {
      target: { type: "tabs", groupId: group.id, index: null },
      preview: group.rect,
    };
  }
  if (alone) return null;
  const extent = edgeDirection(edge) === "row" ? group.rect.width : group.rect.height;
  const size = Math.max(DOCK_GROUP_MIN_SIZE, Math.round(extent / 2));
  return {
    target: { type: "split", nodeId: group.id, edge, size },
    preview: edgeSlice(group.rect, edge, size),
  };
}

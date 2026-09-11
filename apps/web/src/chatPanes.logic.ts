import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "./rightPanelStore";

/**
 * Pure helpers for the chat pane layout: a binary tree of splits whose leaves
 * each show one server thread, or one of that thread's right-panel surfaces.
 * The tree has no depth cap: panes share the screen by ratio while they fit,
 * and the layout scrolls sideways once their minimum widths no longer do.
 */

export type ChatPaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export type DropZone = "top" | "bottom" | "left" | "right";

export interface ChatPaneLeaf {
  readonly kind: "leaf";
  readonly id: ChatPaneId;
  readonly threadRef: ScopedThreadRef;
  /** Present when the pane shows one of the thread's panels instead of the chat. */
  readonly surface?: RightPanelSurface;
}

export interface ChatPaneSplit {
  readonly kind: "split";
  readonly id: ChatPaneId;
  readonly direction: SplitDirection;
  readonly first: ChatPaneNode;
  readonly second: ChatPaneNode;
  /** Share of the axis given to `first`, clamped to [MIN_RATIO, MAX_RATIO]. */
  readonly ratio: number;
}

export type ChatPaneNode = ChatPaneLeaf | ChatPaneSplit;

const MIN_PANE_RATIO = 0.2;
const MAX_PANE_RATIO = 0.8;
const EDGE_REGION_FRACTION = 1 / 3;

export function clampPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

export function collectLeaves(node: ChatPaneNode): ChatPaneLeaf[] {
  return node.kind === "leaf"
    ? [node]
    : [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

/** Any node, leaf or split, by id. The root's id names the whole layout. */
export function findNode(node: ChatPaneNode, id: ChatPaneId): ChatPaneNode | null {
  if (node.id === id) return node;
  if (node.kind === "leaf") return null;
  return findNode(node.first, id) ?? findNode(node.second, id);
}

export function filterPaneTree(
  root: ChatPaneNode,
  include: (leaf: ChatPaneLeaf) => boolean,
): ChatPaneNode | null {
  return collectLeaves(root).reduce<ChatPaneNode | null>(
    (tree, leaf) => (tree && !include(leaf) ? removePane(tree, leaf.id) : tree),
    root,
  );
}

/** The pane showing `threadRef`'s chat, or its surface `surfaceId` when given. */
export function findLeaf(
  node: ChatPaneNode,
  threadRef: ScopedThreadRef,
  surfaceId?: string,
): ChatPaneLeaf | null {
  const threadKey = scopedThreadKey(threadRef);
  return (
    collectLeaves(node).find(
      (leaf) => leaf.surface?.id === surfaceId && scopedThreadKey(leaf.threadRef) === threadKey,
    ) ?? null
  );
}

/** The group showing `threadRef`, or null when the thread renders on its own. */
export function selectChatPaneRoot(
  groups: ReadonlyArray<ChatPaneNode>,
  threadRef: ScopedThreadRef | null,
): ChatPaneNode | null {
  if (!threadRef) return null;
  return groups.find((group) => findLeaf(group, threadRef) !== null) ?? null;
}

function zoneToSplit(zone: DropZone): {
  direction: SplitDirection;
  side: "first" | "second";
} {
  switch (zone) {
    case "left":
      return { direction: "horizontal", side: "first" };
    case "right":
      return { direction: "horizontal", side: "second" };
    case "top":
      return { direction: "vertical", side: "first" };
    case "bottom":
      return { direction: "vertical", side: "second" };
  }
}

/** Wraps the node `targetId` (a pane, or the root for the whole layout) in a split with `newLeaf`. */
export function splitPane(
  root: ChatPaneNode,
  targetId: ChatPaneId,
  zone: DropZone,
  newLeaf: ChatPaneLeaf,
  splitId: ChatPaneId,
): ChatPaneNode {
  const { direction, side } = zoneToSplit(zone);
  const replace = (node: ChatPaneNode): ChatPaneNode => {
    if (node.id === targetId) {
      return {
        kind: "split",
        id: splitId,
        direction,
        ratio: 0.5,
        first: side === "first" ? newLeaf : node,
        second: side === "first" ? node : newLeaf,
      };
    }
    if (node.kind === "leaf") return node;
    const first = replace(node.first);
    const second = replace(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return replace(root);
}

/** Removes a leaf. Its sibling takes the parent's slot; the last leaf leaves an empty layout. */
export function removePane(root: ChatPaneNode, paneId: ChatPaneId): ChatPaneNode | null {
  if (root.id === paneId) return null;
  if (root.kind === "leaf") return root;
  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

/** Replaces the surface `paneId` shows, leaving a pane without one alone. */
export function setPaneSurface(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  surface: RightPanelSurface,
): ChatPaneNode {
  if (root.kind === "leaf") {
    return root.id === paneId && root.surface ? { ...root, surface } : root;
  }
  const first = setPaneSurface(root.first, paneId, surface);
  const second = setPaneSurface(root.second, paneId, surface);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

export function setPaneRatio(root: ChatPaneNode, splitId: ChatPaneId, ratio: number): ChatPaneNode {
  if (root.kind === "leaf") return root;
  if (root.id === splitId) return { ...root, ratio: clampPaneRatio(ratio) };
  const first = setPaneRatio(root.first, splitId, ratio);
  const second = setPaneRatio(root.second, splitId, ratio);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

/**
 * Which edge of a pane the pointer is closest to, VS Code style: the outer
 * third of the long axis wins outright, the middle falls back to the short axis.
 */
export function resolveDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): DropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
  const horizontal: DropZone = relX < 0.5 ? "left" : "right";
  const vertical: DropZone = relY < 0.5 ? "top" : "bottom";
  const wide = rect.width >= rect.height;
  const longRel = wide ? relX : relY;
  if (longRel < EDGE_REGION_FRACTION || longRel > 1 - EDGE_REGION_FRACTION) {
    return wide ? horizontal : vertical;
  }
  return wide ? vertical : horizontal;
}

/** Pointer distance from the layout's outer edge that targets the whole layout. */
const EDGE_DROP_BAND_PX = 28;

/**
 * Which outer edge of the whole layout the pointer sits on, so a drop there
 * spans the full width or height instead of splitting one pane.
 */
export function resolveEdgeDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): DropZone | null {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || x > rect.width || y < 0 || y > rect.height) return null;
  if (y < EDGE_DROP_BAND_PX) return "top";
  if (rect.height - y < EDGE_DROP_BAND_PX) return "bottom";
  if (x < EDGE_DROP_BAND_PX) return "left";
  if (rect.width - x < EDGE_DROP_BAND_PX) return "right";
  return null;
}

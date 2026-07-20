import type { DiffRouteSearch } from "./diffRouteSearch";
import { type ThreadRouteTarget, threadRouteTargetsEqual } from "./threadRoutes";

export type ChatSplitNodeId = string;
export type ChatSplitOrientation = "row" | "column";
export type ChatSplitFocusDirection = "left" | "right" | "up" | "down";
export type ChatSplitDropPlacement = "left" | "right" | "top" | "bottom";

export type ChatSplitNode =
  | {
      kind: "leaf";
      id: ChatSplitNodeId;
      target: ThreadRouteTarget | null;
      diff: DiffRouteSearch;
    }
  | {
      kind: "split";
      id: ChatSplitNodeId;
      orientation: ChatSplitOrientation;
      ratio: number;
      first: ChatSplitNodeId;
      second: ChatSplitNodeId;
    };

export interface ChatSplitLayout {
  rootId: ChatSplitNodeId;
  nodesById: Record<ChatSplitNodeId, ChatSplitNode>;
  focusedLeafId: ChatSplitNodeId;
  maximizedLeafId: ChatSplitNodeId | null;
}

interface ChatSplitPathStep {
  splitId: ChatSplitNodeId;
  branch: "first" | "second";
}

const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

function cloneTarget(target: ThreadRouteTarget): ThreadRouteTarget {
  return target.kind === "server"
    ? {
        kind: "server",
        threadRef: {
          environmentId: target.threadRef.environmentId,
          threadId: target.threadRef.threadId,
        },
      }
    : {
        kind: "draft",
        draftId: target.draftId,
      };
}

export function sanitizeDiffRouteState(diff: DiffRouteSearch | null | undefined): DiffRouteSearch {
  if (!diff || diff.diff !== "1") {
    return {};
  }

  return {
    diff: "1",
    ...(diff.diffTurnId ? { diffTurnId: diff.diffTurnId } : {}),
    ...(diff.diffTurnId && diff.diffFilePath ? { diffFilePath: diff.diffFilePath } : {}),
    ...(diff.diffTurnId && diff.diffScope ? { diffScope: diff.diffScope } : {}),
    ...(diff.reviewFinding ? { reviewFinding: diff.reviewFinding } : {}),
  };
}

export function diffRouteStatesEqual(
  left: DiffRouteSearch | null | undefined,
  right: DiffRouteSearch | null | undefined,
): boolean {
  const nextLeft = sanitizeDiffRouteState(left);
  const nextRight = sanitizeDiffRouteState(right);
  return (
    nextLeft.diff === nextRight.diff &&
    nextLeft.diffTurnId === nextRight.diffTurnId &&
    nextLeft.diffFilePath === nextRight.diffFilePath &&
    nextLeft.diffScope === nextRight.diffScope &&
    nextLeft.reviewFinding === nextRight.reviewFinding
  );
}

export function isLeafNode(
  node: ChatSplitNode | null | undefined,
): node is Extract<ChatSplitNode, { kind: "leaf" }> {
  return node?.kind === "leaf";
}

export function isSplitNode(
  node: ChatSplitNode | null | undefined,
): node is Extract<ChatSplitNode, { kind: "split" }> {
  return node?.kind === "split";
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO;
  }
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function createInitialChatSplitLayout(params: {
  leafId: ChatSplitNodeId;
  target: ThreadRouteTarget;
  diff?: DiffRouteSearch;
}): ChatSplitLayout {
  const { leafId, target, diff } = params;
  return {
    rootId: leafId,
    nodesById: {
      [leafId]: {
        kind: "leaf",
        id: leafId,
        target: cloneTarget(target),
        diff: sanitizeDiffRouteState(diff),
      },
    },
    focusedLeafId: leafId,
    maximizedLeafId: null,
  };
}

export function getNode(
  layout: ChatSplitLayout,
  nodeId: ChatSplitNodeId | null | undefined,
): ChatSplitNode | null {
  if (!nodeId) {
    return null;
  }
  return layout.nodesById[nodeId] ?? null;
}

export function getLeafNode(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId | null | undefined,
): Extract<ChatSplitNode, { kind: "leaf" }> | null {
  const node = getNode(layout, leafId);
  return isLeafNode(node) ? node : null;
}

export function getFocusedLeaf(
  layout: ChatSplitLayout,
): Extract<ChatSplitNode, { kind: "leaf" }> | null {
  return getLeafNode(layout, layout.focusedLeafId);
}

export function countLeafNodes(layout: ChatSplitLayout): number {
  return Object.values(layout.nodesById).reduce(
    (count, node) => (node.kind === "leaf" ? count + 1 : count),
    0,
  );
}

function findLeafPath(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
  nodeId: ChatSplitNodeId = layout.rootId,
  path: ChatSplitPathStep[] = [],
): ChatSplitPathStep[] | null {
  const node = layout.nodesById[nodeId];
  if (!node) {
    return null;
  }
  if (node.kind === "leaf") {
    return node.id === leafId ? path : null;
  }

  const firstPath = findLeafPath(layout, leafId, node.first, [
    ...path,
    { splitId: node.id, branch: "first" },
  ]);
  if (firstPath) {
    return firstPath;
  }
  return findLeafPath(layout, leafId, node.second, [
    ...path,
    { splitId: node.id, branch: "second" },
  ]);
}

export function findLeafNodeByTarget(
  layout: ChatSplitLayout,
  target: ThreadRouteTarget,
): Extract<ChatSplitNode, { kind: "leaf" }> | null {
  for (const node of Object.values(layout.nodesById)) {
    if (node.kind === "leaf" && node.target && threadRouteTargetsEqual(node.target, target)) {
      return node;
    }
  }
  return null;
}

function replaceChildReference(
  layout: ChatSplitLayout,
  splitId: ChatSplitNodeId,
  branch: "first" | "second",
  childId: ChatSplitNodeId,
): ChatSplitLayout {
  const splitNode = layout.nodesById[splitId];
  if (!isSplitNode(splitNode) || splitNode[branch] === childId) {
    return layout;
  }

  return {
    ...layout,
    nodesById: {
      ...layout.nodesById,
      [splitId]: {
        ...splitNode,
        [branch]: childId,
      },
    },
  };
}

function pickLeafForIncomingDirection(
  layout: ChatSplitLayout,
  nodeId: ChatSplitNodeId,
  direction: ChatSplitFocusDirection,
): ChatSplitNodeId | null {
  const node = layout.nodesById[nodeId];
  if (!node) {
    return null;
  }
  if (node.kind === "leaf") {
    return node.id;
  }

  switch (direction) {
    case "left":
      return pickLeafForIncomingDirection(
        layout,
        node.orientation === "row" ? node.second : node.first,
        direction,
      );
    case "right":
      return pickLeafForIncomingDirection(layout, node.first, direction);
    case "up":
      return pickLeafForIncomingDirection(
        layout,
        node.orientation === "column" ? node.second : node.first,
        direction,
      );
    case "down":
      return pickLeafForIncomingDirection(layout, node.first, direction);
  }
}

export function findNeighborLeafId(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
  direction: ChatSplitFocusDirection,
): ChatSplitNodeId | null {
  const path = findLeafPath(layout, leafId);
  if (!path) {
    return null;
  }

  for (let index = path.length - 1; index >= 0; index -= 1) {
    const step = path[index];
    if (!step) {
      continue;
    }
    const splitNode = layout.nodesById[step.splitId];
    if (!isSplitNode(splitNode)) {
      continue;
    }

    const canMove =
      (direction === "left" && splitNode.orientation === "row" && step.branch === "second") ||
      (direction === "right" && splitNode.orientation === "row" && step.branch === "first") ||
      (direction === "up" && splitNode.orientation === "column" && step.branch === "second") ||
      (direction === "down" && splitNode.orientation === "column" && step.branch === "first");

    if (!canMove) {
      continue;
    }

    const siblingId = step.branch === "first" ? splitNode.second : splitNode.first;
    return pickLeafForIncomingDirection(layout, siblingId, direction);
  }

  return null;
}

export function focusLeaf(layout: ChatSplitLayout, leafId: ChatSplitNodeId): ChatSplitLayout {
  if (!getLeafNode(layout, leafId) || layout.focusedLeafId === leafId) {
    return layout;
  }
  return {
    ...layout,
    focusedLeafId: leafId,
  };
}

export function focusNeighbor(
  layout: ChatSplitLayout,
  direction: ChatSplitFocusDirection,
): ChatSplitLayout {
  const neighborLeafId = findNeighborLeafId(layout, layout.focusedLeafId, direction);
  return neighborLeafId ? focusLeaf(layout, neighborLeafId) : layout;
}

export function replaceLeafTarget(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
  target: ThreadRouteTarget,
  diff?: DiffRouteSearch,
): ChatSplitLayout {
  const leafNode = getLeafNode(layout, leafId);
  const nextDiff = sanitizeDiffRouteState(diff);
  if (!leafNode) {
    return layout;
  }

  if (
    leafNode.target &&
    threadRouteTargetsEqual(leafNode.target, target) &&
    diffRouteStatesEqual(leafNode.diff, nextDiff)
  ) {
    return layout;
  }

  return {
    ...layout,
    nodesById: {
      ...layout.nodesById,
      [leafId]: {
        ...leafNode,
        target: cloneTarget(target),
        diff: nextDiff,
      },
    },
  };
}

export function setLeafDiff(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
  diff: DiffRouteSearch,
): ChatSplitLayout {
  const leafNode = getLeafNode(layout, leafId);
  const nextDiff = sanitizeDiffRouteState(diff);
  if (!leafNode || diffRouteStatesEqual(leafNode.diff, nextDiff)) {
    return layout;
  }

  return {
    ...layout,
    nodesById: {
      ...layout.nodesById,
      [leafId]: {
        ...leafNode,
        diff: nextDiff,
      },
    },
  };
}

export function splitLeaf(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
  orientation: ChatSplitOrientation,
  createId: () => ChatSplitNodeId,
): ChatSplitLayout {
  const leafNode = getLeafNode(layout, leafId);
  if (!leafNode) {
    return layout;
  }

  const splitNodeId = createId();
  const newLeafId = createId();
  const nextLayout = {
    ...layout,
    nodesById: {
      ...layout.nodesById,
      [newLeafId]: {
        kind: "leaf",
        id: newLeafId,
        target: null,
        diff: {},
      } satisfies ChatSplitNode,
      [splitNodeId]: {
        kind: "split",
        id: splitNodeId,
        orientation,
        ratio: DEFAULT_SPLIT_RATIO,
        first: leafId,
        second: newLeafId,
      } satisfies ChatSplitNode,
    },
    focusedLeafId: newLeafId,
    maximizedLeafId: null,
  } satisfies ChatSplitLayout;
  const path = findLeafPath(layout, leafId);
  if (!path || path.length === 0) {
    return {
      ...nextLayout,
      rootId: splitNodeId,
    };
  }

  const parentStep = path.at(-1);
  if (!parentStep) {
    return nextLayout;
  }
  return replaceChildReference(nextLayout, parentStep.splitId, parentStep.branch, splitNodeId);
}

export function splitLeafWithTarget(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
  target: ThreadRouteTarget,
  placement: ChatSplitDropPlacement,
  createId: () => ChatSplitNodeId,
): ChatSplitLayout {
  const leafNode = getLeafNode(layout, leafId);
  if (!leafNode) {
    return layout;
  }

  const orientation: ChatSplitOrientation =
    placement === "left" || placement === "right" ? "row" : "column";
  const splitNodeId = createId();
  const newLeafId = createId();
  const insertedFirst = placement === "left" || placement === "top";
  const nextLayout = {
    ...layout,
    nodesById: {
      ...layout.nodesById,
      [newLeafId]: {
        kind: "leaf",
        id: newLeafId,
        target: cloneTarget(target),
        diff: {},
      } satisfies ChatSplitNode,
      [splitNodeId]: {
        kind: "split",
        id: splitNodeId,
        orientation,
        ratio: DEFAULT_SPLIT_RATIO,
        first: insertedFirst ? newLeafId : leafId,
        second: insertedFirst ? leafId : newLeafId,
      } satisfies ChatSplitNode,
    },
    focusedLeafId: newLeafId,
    maximizedLeafId: null,
  } satisfies ChatSplitLayout;
  const path = findLeafPath(layout, leafId);
  if (!path || path.length === 0) {
    return {
      ...nextLayout,
      rootId: splitNodeId,
    };
  }

  const parentStep = path.at(-1);
  if (!parentStep) {
    return nextLayout;
  }
  return replaceChildReference(nextLayout, parentStep.splitId, parentStep.branch, splitNodeId);
}

export function buildChatSplitLayoutFromTargets(params: {
  targets: readonly ThreadRouteTarget[];
  orientation: ChatSplitOrientation;
  createId: () => ChatSplitNodeId;
}): ChatSplitLayout | null {
  const { targets, orientation, createId } = params;
  const [firstTarget, ...remainingTargets] = targets;
  if (!firstTarget) {
    return null;
  }

  let layout = createInitialChatSplitLayout({
    leafId: createId(),
    target: firstTarget,
  });

  for (const target of remainingTargets) {
    const splitLayout = splitLeaf(layout, layout.focusedLeafId, orientation, createId);
    layout = replaceLeafTarget(splitLayout, splitLayout.focusedLeafId, target);
  }

  return layout;
}

export function closeLeaf(layout: ChatSplitLayout, leafId: ChatSplitNodeId): ChatSplitLayout {
  const leafNode = getLeafNode(layout, leafId);
  const path = findLeafPath(layout, leafId);
  if (!leafNode || !path || path.length === 0) {
    return layout;
  }

  const parentStep = path.at(-1);
  if (!parentStep) {
    return layout;
  }
  const parentNode = layout.nodesById[parentStep.splitId];
  if (!isSplitNode(parentNode)) {
    return layout;
  }

  const siblingId = parentStep.branch === "first" ? parentNode.second : parentNode.first;
  const focusDirection =
    parentNode.orientation === "row"
      ? parentStep.branch === "first"
        ? "right"
        : "left"
      : parentStep.branch === "first"
        ? "down"
        : "up";
  const promotedLeafId = pickLeafForIncomingDirection(layout, siblingId, focusDirection);
  const nextNodesById = { ...layout.nodesById };
  delete nextNodesById[leafId];
  delete nextNodesById[parentNode.id];

  const nextBase = {
    ...layout,
    nodesById: nextNodesById,
    focusedLeafId:
      layout.focusedLeafId === leafId
        ? (promotedLeafId ?? layout.focusedLeafId)
        : layout.focusedLeafId,
    maximizedLeafId: layout.maximizedLeafId === leafId ? null : layout.maximizedLeafId,
  } satisfies ChatSplitLayout;

  if (path.length === 1) {
    return {
      ...nextBase,
      rootId: siblingId,
    };
  }

  const grandparentStep = path[path.length - 2];
  if (!grandparentStep) {
    return nextBase;
  }
  return replaceChildReference(
    nextBase,
    grandparentStep.splitId,
    grandparentStep.branch,
    siblingId,
  );
}

export function setSplitRatio(
  layout: ChatSplitLayout,
  splitId: ChatSplitNodeId,
  ratio: number,
): ChatSplitLayout {
  const splitNode = getNode(layout, splitId);
  const nextRatio = clampSplitRatio(ratio);
  if (!isSplitNode(splitNode) || splitNode.ratio === nextRatio) {
    return layout;
  }

  return {
    ...layout,
    nodesById: {
      ...layout.nodesById,
      [splitId]: {
        ...splitNode,
        ratio: nextRatio,
      },
    },
  };
}

export function toggleLeafMaximized(
  layout: ChatSplitLayout,
  leafId: ChatSplitNodeId,
): ChatSplitLayout {
  if (!getLeafNode(layout, leafId)) {
    return layout;
  }
  return {
    ...layout,
    maximizedLeafId: layout.maximizedLeafId === leafId ? null : leafId,
  };
}

export function getFocusedLeafTarget(layout: ChatSplitLayout): ThreadRouteTarget | null {
  return getFocusedLeaf(layout)?.target ?? null;
}

export function getLeafIds(layout: ChatSplitLayout): ChatSplitNodeId[] {
  return Object.values(layout.nodesById)
    .flatMap((node) => (node.kind === "leaf" ? [node.id] : []))
    .toSorted();
}

export interface ChatSplitLeafTarget {
  leafId: ChatSplitNodeId;
  target: ThreadRouteTarget | null;
}

export function getLeafTargetsInRenderOrder(layout: ChatSplitLayout): ChatSplitLeafTarget[] {
  const targets: ChatSplitLeafTarget[] = [];

  const walk = (nodeId: ChatSplitNodeId) => {
    const node = layout.nodesById[nodeId];
    if (!node) {
      return;
    }
    if (node.kind === "leaf") {
      targets.push({ leafId: node.id, target: node.target });
      return;
    }
    walk(node.first);
    walk(node.second);
  };

  walk(layout.rootId);
  return targets;
}

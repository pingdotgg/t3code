export type PaneId = `pane:${string}`;
export type PaneSplitId = `pane-split:${string}`;
export type PaneTabId = `pane-tab:${string}`;

export type PaneSplitDirection = "up" | "down" | "left" | "right";
export type PaneSplitOrientation = "horizontal" | "vertical";
export type PaneDropZone = PaneSplitDirection | "center";

/** Identifies the tree tab currently being dragged. */
export interface PaneTabDragData {
  readonly sourcePaneId: PaneId;
  readonly sourceTabId: PaneTabId;
}

export interface PaneNode {
  readonly _tag: "Group";
  readonly id: PaneId;
  readonly tabIds: readonly PaneTabId[];
  readonly activeTabId: PaneTabId | null;
}

export interface PaneSplitNode {
  readonly _tag: "Split";
  readonly id: PaneSplitId;
  readonly orientation: PaneSplitOrientation;
  readonly ratio: number;
  readonly first: PaneTreeNode;
  readonly second: PaneTreeNode;
}

export type PaneTreeNode = PaneNode | PaneSplitNode;

export interface PaneTree {
  readonly root: PaneTreeNode;
  readonly focusedPaneId: PaneId;
  readonly maximizedPaneId: PaneId | null;
}

export interface SplitPaneTabInput {
  readonly sourcePaneId: PaneId;
  readonly sourceTabId: PaneTabId;
  readonly targetTabId: PaneTabId;
  readonly targetPaneId: PaneId;
  readonly splitId: PaneSplitId;
  readonly direction: PaneSplitDirection;
  readonly mode: "copy" | "move";
}

export interface SplitPaneInput {
  readonly sourcePaneId: PaneId;
  readonly targetPaneId: PaneId;
  readonly splitId: PaneSplitId;
  readonly direction: PaneSplitDirection;
}

/** Moves one tab from its current pane into an existing group. */
export interface MovePaneTabInput {
  readonly sourcePaneId: PaneId;
  readonly targetPaneId: PaneId;
  readonly tabId: PaneTabId;
  readonly targetIndex?: number;
}

/** Moves one tab into a new split positioned around an existing target group. */
export interface MoveTabToPaneSplitInput extends PaneTabDragData {
  readonly targetPaneId: PaneId;
  readonly newPaneId: PaneId;
  readonly splitId: PaneSplitId;
  readonly direction: PaneSplitDirection;
}

/** The closest pane in each direction from a source group. */
export interface AdjacentPanes {
  readonly up: PaneId | null;
  readonly down: PaneId | null;
  readonly left: PaneId | null;
  readonly right: PaneId | null;
}

export interface PaneBounds {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface SplitPaneLayout {
  readonly group: PaneNode;
  readonly bounds: PaneBounds;
}

export interface PaneSplitLayout {
  readonly split: PaneSplitNode;
  readonly bounds: PaneBounds;
}

export interface PaneTreeLayout {
  readonly groups: readonly SplitPaneLayout[];
  readonly splits: readonly PaneSplitLayout[];
}

const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;

export function clampPaneSplitRatio(ratio: number): number | null {
  if (!Number.isFinite(ratio)) return null;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function createPaneTree(input: {
  readonly paneId: PaneId;
  readonly tabIds?: readonly PaneTabId[];
  readonly activeTabId?: PaneTabId | null;
}): PaneTree {
  const tabIds = input.tabIds ?? [];
  const activeTabId = resolveActiveTabId(tabIds, input.activeTabId ?? null);
  return {
    root: { _tag: "Group", id: input.paneId, tabIds, activeTabId },
    focusedPaneId: input.paneId,
    maximizedPaneId: null,
  };
}

export function getPanes(node: PaneTreeNode): readonly PaneNode[] {
  return node._tag === "Group" ? [node] : [...getPanes(node.first), ...getPanes(node.second)];
}

export function findPane(node: PaneTreeNode, paneId: PaneId): PaneNode | null {
  if (node._tag === "Group") return node.id === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

/** Returns the full layout or the single group selected for Focus View. */
export function getVisiblePaneTreeRoot(tree: PaneTree): PaneTreeNode {
  if (!tree.maximizedPaneId) return tree.root;
  return findPane(tree.root, tree.maximizedPaneId) ?? tree.root;
}

export function findTopRightPane(node: PaneTreeNode): PaneNode {
  if (node._tag === "Group") return node;
  return findTopRightPane(node.orientation === "horizontal" ? node.second : node.first);
}

export function getTopPanes(node: PaneTreeNode): readonly PaneNode[] {
  return calculatePaneTreeLayout(node).groups.flatMap(({ group, bounds }) =>
    bounds.top === 0 ? [group] : [],
  );
}

/** Projects the split tree into stable, normalized group and divider geometry. */
export function calculatePaneTreeLayout(root: PaneTreeNode): PaneTreeLayout {
  const groups: SplitPaneLayout[] = [];
  const splits: PaneSplitLayout[] = [];
  collectPaneTreeLayout(root, { top: 0, right: 1, bottom: 1, left: 0 }, groups, splits);
  return { groups, splits };
}

/** Finds the closest spatially adjacent pane in every direction. */
export function findAdjacentPanes(tree: PaneTree, paneId: PaneId): AdjacentPanes {
  const groups = calculatePaneTreeLayout(tree.root).groups;
  const source = groups.find((entry) => entry.group.id === paneId);
  if (!source) {
    return { up: null, down: null, left: null, right: null };
  }
  return {
    up: findDirectionalPane(groups, source, "up"),
    down: findDirectionalPane(groups, source, "down"),
    left: findDirectionalPane(groups, source, "left"),
    right: findDirectionalPane(groups, source, "right"),
  };
}

export function focusPane(tree: PaneTree, paneId: PaneId): PaneTree {
  return findPane(tree.root, paneId)
    ? {
        ...tree,
        focusedPaneId: paneId,
        maximizedPaneId: tree.maximizedPaneId ? paneId : null,
      }
    : tree;
}

/** Toggles Focus View for one pane without changing the split tree. */
export function toggleMaximizedPane(tree: PaneTree, paneId = tree.focusedPaneId): PaneTree {
  if (!findPane(tree.root, paneId)) return tree;
  return {
    ...tree,
    focusedPaneId: paneId,
    maximizedPaneId: tree.maximizedPaneId === paneId ? null : paneId,
  };
}

export function openPaneTab(
  tree: PaneTree,
  tabId: PaneTabId,
  paneId = tree.focusedPaneId,
): PaneTree {
  return updatePane(tree, paneId, (group) => ({
    ...group,
    tabIds: group.tabIds.includes(tabId) ? group.tabIds : [...group.tabIds, tabId],
    activeTabId: tabId,
  }));
}

export function activatePaneTab(tree: PaneTree, paneId: PaneId, tabId: PaneTabId): PaneTree {
  const group = findPane(tree.root, paneId);
  if (!group?.tabIds.includes(tabId)) return tree;
  return {
    ...updatePane(tree, paneId, (current) => ({
      ...current,
      activeTabId: tabId,
    })),
    focusedPaneId: paneId,
    maximizedPaneId: tree.maximizedPaneId ? paneId : null,
  };
}

/** Reorders a tab within one group while preserving the active tab. */
export function reorderPaneTab(
  tree: PaneTree,
  input: {
    readonly paneId: PaneId;
    readonly tabId: PaneTabId;
    readonly targetIndex: number;
  },
): PaneTree {
  const group = findPane(tree.root, input.paneId);
  const sourceIndex = group?.tabIds.indexOf(input.tabId) ?? -1;
  if (
    !group ||
    sourceIndex < 0 ||
    !Number.isSafeInteger(input.targetIndex) ||
    input.targetIndex < 0 ||
    input.targetIndex >= group.tabIds.length ||
    sourceIndex === input.targetIndex
  ) {
    return tree;
  }
  const tabIds = [...group.tabIds];
  tabIds.splice(sourceIndex, 1);
  tabIds.splice(input.targetIndex, 0, input.tabId);
  return updatePane(tree, group.id, (current) => ({ ...current, tabIds }));
}

/** Moves a tab into an existing group and collapses an emptied source group. */
export function moveTabToPane(tree: PaneTree, input: MovePaneTabInput): PaneTree {
  if (input.sourcePaneId === input.targetPaneId) return tree;
  const sourceGroup = findPane(tree.root, input.sourcePaneId);
  const targetGroup = findPane(tree.root, input.targetPaneId);
  if (!sourceGroup?.tabIds.includes(input.tabId) || !targetGroup) return tree;
  const targetIndex = input.targetIndex ?? targetGroup.tabIds.length;
  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex > targetGroup.tabIds.length ||
    targetGroup.tabIds.includes(input.tabId)
  ) {
    return tree;
  }
  const sourceAfterMove = removeTabFromGroup(sourceGroup, input.tabId);
  const targetTabIds = [...targetGroup.tabIds];
  targetTabIds.splice(targetIndex, 0, input.tabId);
  let root = mapPaneNode(tree.root, (node) => {
    if (node._tag !== "Group") return node;
    if (node.id === sourceGroup.id) return sourceAfterMove;
    if (node.id === targetGroup.id) {
      return { ...node, tabIds: targetTabIds, activeTabId: input.tabId };
    }
    return node;
  });
  if (sourceAfterMove.tabIds.length === 0) {
    root = collapsePane(root, sourceGroup.id) ?? root;
  }
  return {
    root,
    focusedPaneId: targetGroup.id,
    maximizedPaneId: tree.maximizedPaneId ? targetGroup.id : null,
  };
}

/** Moves a tab to a new split at an arbitrary target group. */
export function moveTabToPaneSplit(tree: PaneTree, input: MoveTabToPaneSplitInput): PaneTree {
  if (input.sourcePaneId === input.targetPaneId) {
    return splitPaneTab(tree, {
      sourcePaneId: input.sourcePaneId,
      sourceTabId: input.sourceTabId,
      targetTabId: input.sourceTabId,
      targetPaneId: input.newPaneId,
      splitId: input.splitId,
      direction: input.direction,
      mode: "move",
    });
  }

  const sourceGroup = findPane(tree.root, input.sourcePaneId);
  const targetGroup = findPane(tree.root, input.targetPaneId);
  if (
    !sourceGroup?.tabIds.includes(input.sourceTabId) ||
    !targetGroup ||
    findPane(tree.root, input.newPaneId)
  ) {
    return tree;
  }

  const sourceAfterMove = removeTabFromGroup(sourceGroup, input.sourceTabId);
  let root = mapPaneNode(tree.root, (node) =>
    node._tag === "Group" && node.id === sourceGroup.id ? sourceAfterMove : node,
  );
  if (sourceAfterMove.tabIds.length === 0) {
    root = collapsePane(root, sourceGroup.id) ?? root;
  }
  const targetAfterMove = findPane(root, targetGroup.id);
  if (!targetAfterMove) return tree;

  const movedGroup: PaneNode = {
    _tag: "Group",
    id: input.newPaneId,
    tabIds: [input.sourceTabId],
    activeTabId: input.sourceTabId,
  };
  const movedGroupFirst = input.direction === "left" || input.direction === "up";
  const split: PaneSplitNode = {
    _tag: "Split",
    id: input.splitId,
    orientation:
      input.direction === "left" || input.direction === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: movedGroupFirst ? movedGroup : targetAfterMove,
    second: movedGroupFirst ? targetAfterMove : movedGroup,
  };
  root = replacePane(root, targetAfterMove.id, split);
  return {
    root,
    focusedPaneId: movedGroup.id,
    maximizedPaneId: null,
  };
}

/** Swaps two panes in-place without changing either group's tabs. */
export function swapPanes(tree: PaneTree, sourcePaneId: PaneId, targetPaneId: PaneId): PaneTree {
  if (sourcePaneId === targetPaneId) return tree;
  const sourceGroup = findPane(tree.root, sourcePaneId);
  const targetGroup = findPane(tree.root, targetPaneId);
  if (!sourceGroup || !targetGroup) return tree;
  const root = mapPaneNode(tree.root, (node) => {
    if (node._tag !== "Group") return node;
    if (node.id === sourceGroup.id) return targetGroup;
    if (node.id === targetGroup.id) return sourceGroup;
    return node;
  });
  return root === tree.root ? tree : { ...tree, root };
}

/** Creates and focuses an empty pane beside an existing group. */
export function splitPane(tree: PaneTree, input: SplitPaneInput): PaneTree {
  const sourceGroup = findPane(tree.root, input.sourcePaneId);
  if (!sourceGroup || findPane(tree.root, input.targetPaneId)) return tree;

  const targetGroup: PaneNode = {
    _tag: "Group",
    id: input.targetPaneId,
    tabIds: [],
    activeTabId: null,
  };
  const newGroupFirst = input.direction === "left" || input.direction === "up";
  const split: PaneSplitNode = {
    _tag: "Split",
    id: input.splitId,
    orientation:
      input.direction === "left" || input.direction === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: newGroupFirst ? targetGroup : sourceGroup,
    second: newGroupFirst ? sourceGroup : targetGroup,
  };
  const root = replacePane(tree.root, input.sourcePaneId, split);
  return root === tree.root ? tree : { root, focusedPaneId: targetGroup.id, maximizedPaneId: null };
}

export function splitPaneTab(tree: PaneTree, input: SplitPaneTabInput): PaneTree {
  const sourceGroup = findPane(tree.root, input.sourcePaneId);
  if (!sourceGroup?.tabIds.includes(input.sourceTabId)) return tree;
  if (findPane(tree.root, input.targetPaneId)) return tree;
  if (input.mode === "move" && sourceGroup.tabIds.length === 1) return tree;

  const sourceAfterMove =
    input.mode === "move" ? removeTabFromGroup(sourceGroup, input.sourceTabId) : sourceGroup;
  const targetGroup: PaneNode = {
    _tag: "Group",
    id: input.targetPaneId,
    tabIds: [input.targetTabId],
    activeTabId: input.targetTabId,
  };
  const newGroupFirst = input.direction === "left" || input.direction === "up";
  const split: PaneSplitNode = {
    _tag: "Split",
    id: input.splitId,
    orientation:
      input.direction === "left" || input.direction === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: newGroupFirst ? targetGroup : sourceAfterMove,
    second: newGroupFirst ? sourceAfterMove : targetGroup,
  };
  const root = replacePane(tree.root, input.sourcePaneId, split);
  if (root === tree.root) return tree;
  return { root, focusedPaneId: input.targetPaneId, maximizedPaneId: null };
}

export function closePaneTab(tree: PaneTree, paneId: PaneId, tabId: PaneTabId): PaneTree {
  const group = findPane(tree.root, paneId);
  if (!group?.tabIds.includes(tabId)) return tree;
  if (group.tabIds.length > 1 || tree.root._tag === "Group") {
    return updatePane(tree, paneId, (current) => removeTabFromGroup(current, tabId));
  }
  return removePane(tree, paneId);
}

export function closeOtherPaneTabs(tree: PaneTree, paneId: PaneId, tabId: PaneTabId): PaneTree {
  const group = findPane(tree.root, paneId);
  if (!group?.tabIds.includes(tabId) || group.tabIds.length === 1) return tree;
  return updatePane(tree, paneId, (current) => ({
    ...current,
    tabIds: [tabId],
    activeTabId: tabId,
  }));
}

export function closePaneTabsToRight(tree: PaneTree, paneId: PaneId, tabId: PaneTabId): PaneTree {
  const group = findPane(tree.root, paneId);
  const tabIndex = group?.tabIds.indexOf(tabId) ?? -1;
  if (!group || tabIndex < 0 || tabIndex === group.tabIds.length - 1) return tree;
  const tabIds = group.tabIds.slice(0, tabIndex + 1);
  return updatePane(tree, paneId, (current) => ({
    ...current,
    tabIds,
    activeTabId: resolveActiveTabId(tabIds, current.activeTabId),
  }));
}

export function closeAllPaneTabs(tree: PaneTree, paneId: PaneId): PaneTree {
  const group = findPane(tree.root, paneId);
  if (!group || group.tabIds.length === 0) return tree;
  if (tree.root._tag !== "Group") return removePane(tree, paneId);
  return updatePane(tree, paneId, (current) => ({
    ...current,
    tabIds: [],
    activeTabId: null,
  }));
}

/** Collapses an unused split without allowing populated or root groups to disappear. */
export function closeEmptyPane(tree: PaneTree, paneId: PaneId): PaneTree {
  const group = findPane(tree.root, paneId);
  if (!group || group.tabIds.length > 0 || tree.root._tag === "Group") return tree;
  return removePane(tree, paneId);
}

export function resizePaneSplit(tree: PaneTree, splitId: PaneSplitId, ratio: number): PaneTree {
  const nextRatio = clampPaneSplitRatio(ratio);
  if (nextRatio === null) return tree;
  const root = mapPaneNode(tree.root, (node) =>
    node._tag === "Split" && node.id === splitId ? { ...node, ratio: nextRatio } : node,
  );
  return root === tree.root ? tree : { ...tree, root };
}

function updatePane(
  tree: PaneTree,
  paneId: PaneId,
  update: (group: PaneNode) => PaneNode,
): PaneTree {
  const root = mapPaneNode(tree.root, (node) =>
    node._tag === "Group" && node.id === paneId ? update(node) : node,
  );
  return root === tree.root ? tree : { ...tree, root };
}

function removePane(tree: PaneTree, paneId: PaneId): PaneTree {
  const root = collapsePane(tree.root, paneId);
  if (!root) return tree;
  const focusedPaneId = findPane(root, tree.focusedPaneId)
    ? tree.focusedPaneId
    : getPanes(root)[0]?.id;
  return focusedPaneId
    ? {
        root,
        focusedPaneId,
        maximizedPaneId: tree.maximizedPaneId ? focusedPaneId : null,
      }
    : tree;
}

function collapsePane(node: PaneTreeNode, paneId: PaneId): PaneTreeNode | null {
  if (node._tag === "Group") return node.id === paneId ? null : node;
  const first = collapsePane(node.first, paneId);
  const second = collapsePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function replacePane(node: PaneTreeNode, paneId: PaneId, replacement: PaneTreeNode): PaneTreeNode {
  if (node._tag === "Group") return node.id === paneId ? replacement : node;
  const first = replacePane(node.first, paneId, replacement);
  const second = replacePane(node.second, paneId, replacement);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function mapPaneNode(node: PaneTreeNode, map: (node: PaneTreeNode) => PaneTreeNode): PaneTreeNode {
  if (node._tag === "Group") return map(node);
  const first = mapPaneNode(node.first, map);
  const second = mapPaneNode(node.second, map);
  return map(first === node.first && second === node.second ? node : { ...node, first, second });
}

function collectPaneTreeLayout(
  node: PaneTreeNode,
  bounds: PaneBounds,
  groups: SplitPaneLayout[],
  splits: PaneSplitLayout[],
): void {
  if (node._tag === "Group") {
    groups.push({ group: node, bounds });
    return;
  }
  splits.push({ split: node, bounds });
  if (node.orientation === "horizontal") {
    const splitAt = bounds.left + (bounds.right - bounds.left) * node.ratio;
    collectPaneTreeLayout(node.first, { ...bounds, right: splitAt }, groups, splits);
    collectPaneTreeLayout(node.second, { ...bounds, left: splitAt }, groups, splits);
    return;
  }
  const splitAt = bounds.top + (bounds.bottom - bounds.top) * node.ratio;
  collectPaneTreeLayout(node.first, { ...bounds, bottom: splitAt }, groups, splits);
  collectPaneTreeLayout(node.second, { ...bounds, top: splitAt }, groups, splits);
}

function findDirectionalPane(
  groups: readonly SplitPaneLayout[],
  source: SplitPaneLayout,
  direction: PaneSplitDirection,
): PaneId | null {
  const candidates = groups.flatMap((candidate, order) => {
    if (candidate.group.id === source.group.id) return [];
    const verticalOverlap =
      Math.min(source.bounds.bottom, candidate.bounds.bottom) -
      Math.max(source.bounds.top, candidate.bounds.top);
    const horizontalOverlap =
      Math.min(source.bounds.right, candidate.bounds.right) -
      Math.max(source.bounds.left, candidate.bounds.left);
    const overlap =
      direction === "left" || direction === "right" ? verticalOverlap : horizontalOverlap;
    if (overlap <= 0) return [];
    const distance = paneDistance(source.bounds, candidate.bounds, direction);
    return distance < 0 ? [] : [{ paneId: candidate.group.id, distance, overlap, order }];
  });
  candidates.sort((left, right) =>
    left.distance !== right.distance
      ? left.distance - right.distance
      : left.overlap !== right.overlap
        ? right.overlap - left.overlap
        : left.order - right.order,
  );
  return candidates[0]?.paneId ?? null;
}

function paneDistance(
  source: PaneBounds,
  candidate: PaneBounds,
  direction: PaneSplitDirection,
): number {
  switch (direction) {
    case "up":
      return source.top - candidate.bottom;
    case "down":
      return candidate.top - source.bottom;
    case "left":
      return source.left - candidate.right;
    case "right":
      return candidate.left - source.right;
  }
}

function removeTabFromGroup(group: PaneNode, tabId: PaneTabId): PaneNode {
  const tabIndex = group.tabIds.indexOf(tabId);
  if (tabIndex < 0) return group;
  const tabIds = group.tabIds.filter((candidate) => candidate !== tabId);
  const fallbackActiveTabId = tabIds[Math.min(tabIndex, tabIds.length - 1)] ?? null;
  return {
    ...group,
    tabIds,
    activeTabId:
      group.activeTabId === tabId
        ? fallbackActiveTabId
        : resolveActiveTabId(tabIds, group.activeTabId),
  };
}

function resolveActiveTabId(
  tabIds: readonly PaneTabId[],
  requestedTabId: PaneTabId | null,
): PaneTabId | null {
  return requestedTabId && tabIds.includes(requestedTabId) ? requestedTabId : (tabIds[0] ?? null);
}

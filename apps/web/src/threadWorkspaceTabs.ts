import * as Schema from "effect/Schema";

import {
  activatePaneTab,
  clampPaneSplitRatio,
  closeEmptyPane,
  closePaneTab,
  createPaneTree,
  findAdjacentPanes,
  findPane,
  focusPane,
  getPanes,
  moveTabToPane,
  moveTabToPaneSplit,
  openPaneTab,
  reorderPaneTab,
  resizePaneSplit,
  splitPane,
  splitPaneTab,
  swapPanes,
  toggleMaximizedPane,
  type PaneId,
  type PaneDropZone,
  type PaneSplitId,
  type PaneSplitDirection,
  type PaneTabDragData,
  type PaneTabId,
  type PaneTree,
  type PaneTreeNode,
} from "./splitPaneTree";

export type ThreadWorkspaceTab =
  | { readonly _tag: "Thread"; readonly id: PaneTabId }
  | { readonly _tag: "Surface"; readonly id: PaneTabId; readonly surfaceId: string };

/** The persisted pane placement for one thread. Surface descriptors remain in rightPanelStore. */
export interface ThreadWorkspaceTabFields {
  readonly paneTree: PaneTree;
  readonly tabsById: Readonly<Record<string, ThreadWorkspaceTab>>;
  readonly nextId: number;
}

export type ThreadWorkspaceTabTransition =
  | { readonly _tag: "ReconcileSurfaceTabs"; readonly surfaceIds: readonly string[] }
  | { readonly _tag: "ActivateThread" }
  | { readonly _tag: "ActivateSurfaceTab"; readonly surfaceId: string }
  | { readonly _tag: "OpenSurfaceTab"; readonly surfaceId: string }
  | {
      readonly _tag: "ReplaceSurfaceTabs";
      readonly previousSurfaceId: string;
      readonly nextSurfaceId: string;
    }
  | { readonly _tag: "ActivateTab"; readonly paneId: PaneId; readonly tabId: PaneTabId }
  | { readonly _tag: "FocusPane"; readonly paneId: PaneId }
  | { readonly _tag: "TogglePaneMaximized"; readonly paneId: PaneId }
  | { readonly _tag: "ResizeSplit"; readonly splitId: PaneSplitId; readonly ratio: number }
  | {
      readonly _tag: "SplitPane";
      readonly paneId: PaneId;
      readonly direction: PaneSplitDirection;
    }
  | {
      readonly _tag: "SplitTab";
      readonly paneId: PaneId;
      readonly tabId: PaneTabId;
      readonly direction: PaneSplitDirection;
      readonly mode: "copy" | "move";
    }
  | {
      readonly _tag: "ReorderTab";
      readonly paneId: PaneId;
      readonly tabId: PaneTabId;
      readonly targetIndex: number;
    }
  | {
      readonly _tag: "MoveTabToPane";
      readonly sourcePaneId: PaneId;
      readonly targetPaneId: PaneId;
      readonly tabId: PaneTabId;
      readonly targetIndex?: number;
    }
  | {
      readonly _tag: "MoveTabToSplit";
      readonly sourcePaneId: PaneId;
      readonly targetPaneId: PaneId;
      readonly tabId: PaneTabId;
      readonly direction: PaneSplitDirection;
    }
  | {
      readonly _tag: "SwapPanes";
      readonly sourcePaneId: PaneId;
      readonly targetPaneId: PaneId;
    }
  | {
      readonly _tag: "CloseSurfaceTab";
      readonly paneId: PaneId;
      readonly tabId: PaneTabId;
    }
  | {
      readonly _tag: "CloseOtherSurfaceTabs";
      readonly paneId: PaneId;
      readonly tabId: PaneTabId;
    }
  | {
      readonly _tag: "CloseSurfaceTabsToRight";
      readonly paneId: PaneId;
      readonly tabId: PaneTabId;
    }
  | { readonly _tag: "CloseAllSurfaceTabs"; readonly paneId: PaneId }
  | { readonly _tag: "CloseEmptyPane"; readonly paneId: PaneId };

/** User-facing pane and tab operations handled by the thread workspace. */
export type ThreadWorkspaceLayoutTransition = Exclude<
  ThreadWorkspaceTabTransition,
  {
    readonly _tag:
      | "ReconcileSurfaceTabs"
      | "ActivateSurfaceTab"
      | "OpenSurfaceTab"
      | "ReplaceSurfaceTabs";
  }
>;

/** Resolves a validated pane drop into the layout transition the workspace applies. */
export function threadWorkspaceTabDropTransition(
  current: ThreadWorkspaceTabFields,
  input: {
    readonly draggedTab: PaneTabDragData;
    readonly targetPaneId: PaneId;
    readonly zone: PaneDropZone;
  },
): ThreadWorkspaceLayoutTransition {
  if (input.zone === "center") {
    return {
      _tag: "SwapPanes",
      sourcePaneId: input.draggedTab.sourcePaneId,
      targetPaneId: input.targetPaneId,
    };
  }
  const sourcePane = findPane(current.paneTree.root, input.draggedTab.sourcePaneId);
  const sourceTab = current.tabsById[input.draggedTab.sourceTabId];
  if (
    input.draggedTab.sourcePaneId === input.targetPaneId &&
    sourcePane?.tabIds.length === 1 &&
    sourceTab?._tag === "Surface"
  ) {
    return {
      _tag: "SplitTab",
      paneId: input.draggedTab.sourcePaneId,
      tabId: input.draggedTab.sourceTabId,
      direction: input.zone,
      mode: "copy",
    };
  }
  return {
    _tag: "MoveTabToSplit",
    sourcePaneId: input.draggedTab.sourcePaneId,
    targetPaneId: input.targetPaneId,
    tabId: input.draggedTab.sourceTabId,
    direction: input.zone,
  };
}

const ROOT_GROUP_ID: PaneId = "pane:root";
const THREAD_TAB_ID: PaneTabId = "pane-tab:thread";

function makePaneId(sequence: number): PaneId {
  return `pane:${sequence}`;
}

function makePaneSplitId(sequence: number): PaneSplitId {
  return `pane-split:${sequence}`;
}

function makePaneTabId(sequence: number): PaneTabId {
  return `pane-tab:${sequence}`;
}

interface PersistedPaneNode {
  readonly _tag: "Group";
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

interface PersistedPaneSplitNode {
  readonly _tag: "Split";
  readonly id: string;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: number;
  readonly first: PersistedPaneTreeNode;
  readonly second: PersistedPaneTreeNode;
}

type PersistedPaneTreeNode = PersistedPaneNode | PersistedPaneSplitNode;

const PersistedPaneTreeNodeRef = Schema.suspend(
  (): Schema.Codec<PersistedPaneTreeNode> => PersistedPaneTreeNodeSchema,
);
const PersistedPaneTreeNodeSchema = Schema.Union([
  Schema.TaggedStruct("Group", {
    id: Schema.String,
    tabIds: Schema.Array(Schema.String),
    activeTabId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Split", {
    id: Schema.String,
    orientation: Schema.Literals(["horizontal", "vertical"]),
    ratio: Schema.Finite,
    first: PersistedPaneTreeNodeRef,
    second: PersistedPaneTreeNodeRef,
  }),
]);

const PersistedThreadWorkspaceTabSchema = Schema.Union([
  Schema.TaggedStruct("Thread", { id: Schema.String }),
  Schema.TaggedStruct("Surface", {
    id: Schema.String,
    surfaceId: Schema.NonEmptyString,
  }),
]);

const PersistedThreadWorkspaceTabFieldsSchema = Schema.Struct({
  paneTree: Schema.Struct({
    root: PersistedPaneTreeNodeSchema,
    focusedPaneId: Schema.String,
    maximizedPaneId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  tabsById: Schema.Record(Schema.String, PersistedThreadWorkspaceTabSchema),
  nextId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const decodePersistedThreadWorkspaceTabFields = Schema.decodeUnknownOption(
  PersistedThreadWorkspaceTabFieldsSchema,
);

export function createThreadWorkspaceTabFields(
  surfaceIds: readonly string[] = [],
): ThreadWorkspaceTabFields {
  let next: ThreadWorkspaceTabFields = {
    paneTree: createPaneTree({ paneId: ROOT_GROUP_ID, tabIds: [THREAD_TAB_ID] }),
    tabsById: { [THREAD_TAB_ID]: { _tag: "Thread", id: THREAD_TAB_ID } },
    nextId: 1,
  };
  for (const surfaceId of surfaceIds) {
    next = addSurfaceTab(next, surfaceId, false);
  }
  return next;
}

function reconcileThreadWorkspaceTabFields(
  current: ThreadWorkspaceTabFields,
  surfaceIds: readonly string[],
): ThreadWorkspaceTabFields {
  const validSurfaceIds = new Set(surfaceIds);
  let next = current;
  for (const tab of Object.values(next.tabsById)) {
    if (tab._tag === "Surface" && !validSurfaceIds.has(tab.surfaceId)) {
      next = closeWorkspaceTab(next, tab.id);
    }
  }
  for (const surfaceId of surfaceIds) {
    if (!findSurfaceTabs(next, surfaceId).length) {
      next = addSurfaceTab(next, surfaceId, false);
    }
  }
  return next;
}

/** Applies every thread-workspace rule through the same pure interface used by the store. */
export function transitionThreadWorkspaceTabs(
  current: ThreadWorkspaceTabFields,
  input: ThreadWorkspaceTabTransition,
): ThreadWorkspaceTabFields {
  switch (input._tag) {
    case "ReconcileSurfaceTabs":
      return reconcileThreadWorkspaceTabFields(current, input.surfaceIds);
    case "ActivateThread":
      return activateThreadWorkspaceTab(current);
    case "ActivateSurfaceTab":
      return activateSurfaceWorkspaceTab(current, input.surfaceId);
    case "OpenSurfaceTab":
      return openSurfaceWorkspaceTab(current, input.surfaceId);
    case "ReplaceSurfaceTabs":
      return replaceSurfaceWorkspaceTabs(current, input.previousSurfaceId, input.nextSurfaceId);
    case "ActivateTab": {
      const workspace = activatePaneTab(current.paneTree, input.paneId, input.tabId);
      return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
    }
    case "FocusPane": {
      const workspace = focusPane(current.paneTree, input.paneId);
      return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
    }
    case "TogglePaneMaximized": {
      const workspace = toggleMaximizedPane(current.paneTree, input.paneId);
      return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
    }
    case "ResizeSplit": {
      const workspace = resizePaneSplit(current.paneTree, input.splitId, input.ratio);
      return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
    }
    case "SplitPane":
      return splitThreadWorkspacePane(current, input.paneId, input.direction);
    case "SplitTab":
      return splitThreadWorkspaceTab(current, input);
    case "ReorderTab":
      return reorderThreadWorkspaceTab(current, input);
    case "MoveTabToPane":
      return moveThreadWorkspaceTabToPane(current, input);
    case "MoveTabToSplit":
      return moveThreadWorkspaceTabToSplit(current, input);
    case "SwapPanes":
      return swapThreadWorkspacePanes(current, input);
    case "CloseSurfaceTab":
      return closeThreadWorkspaceSurfaceTab(current, input.paneId, input.tabId);
    case "CloseOtherSurfaceTabs":
      return closeOtherThreadWorkspaceSurfaceTabs(current, input.paneId, input.tabId);
    case "CloseSurfaceTabsToRight":
      return closeThreadWorkspaceSurfaceTabsToRight(current, input.paneId, input.tabId);
    case "CloseAllSurfaceTabs":
      return closeAllThreadWorkspaceSurfaceTabs(current, input.paneId);
    case "CloseEmptyPane": {
      const workspace = closeEmptyPane(current.paneTree, input.paneId);
      return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
    }
  }
}

function replaceSurfaceWorkspaceTabs(
  current: ThreadWorkspaceTabFields,
  previousSurfaceId: string,
  nextSurfaceId: string,
): ThreadWorkspaceTabFields {
  if (previousSurfaceId === nextSurfaceId) return current;
  let next = current;
  for (const previousTab of findSurfaceTabs(current, previousSurfaceId)) {
    const paneId = findThreadWorkspaceTabGroup(next, previousTab.id);
    const group = paneId ? findPane(next.paneTree.root, paneId) : null;
    if (!paneId || !group) continue;
    const equivalentTabId = group.tabIds.find((tabId) => {
      const tab = next.tabsById[tabId];
      return tabId !== previousTab.id && tab?._tag === "Surface" && tab.surfaceId === nextSurfaceId;
    });
    if (equivalentTabId) {
      const wasActive = group.activeTabId === previousTab.id;
      next = closeWorkspaceTab(next, previousTab.id, paneId);
      if (wasActive) {
        const workspace = activatePaneTab(next.paneTree, paneId, equivalentTabId);
        next = workspace === next.paneTree ? next : { ...next, paneTree: workspace };
      }
      continue;
    }
    next = {
      ...next,
      tabsById: {
        ...next.tabsById,
        [previousTab.id]: { ...previousTab, surfaceId: nextSurfaceId },
      },
    };
  }
  return next;
}

function activateThreadWorkspaceTab(current: ThreadWorkspaceTabFields): ThreadWorkspaceTabFields {
  const threadTab = Object.values(current.tabsById).find((tab) => tab._tag === "Thread");
  if (!threadTab) return current;
  return activateWorkspaceTab(current, threadTab.id);
}

function activateSurfaceWorkspaceTab(
  current: ThreadWorkspaceTabFields,
  surfaceId: string,
): ThreadWorkspaceTabFields {
  const focusedGroup = findPane(current.paneTree.root, current.paneTree.focusedPaneId);
  const focusedTab = focusedGroup?.tabIds
    .map((tabId) => current.tabsById[tabId])
    .find((tab) => tab?._tag === "Surface" && tab.surfaceId === surfaceId);
  const existingTab = focusedTab ?? findSurfaceTabs(current, surfaceId)[0];
  return existingTab
    ? activateWorkspaceTab(current, existingTab.id)
    : addSurfaceTab(current, surfaceId);
}

/** Opens a surface in the focused group, allowing the same surface in separate groups. */
function openSurfaceWorkspaceTab(
  current: ThreadWorkspaceTabFields,
  surfaceId: string,
): ThreadWorkspaceTabFields {
  const focusedGroup = findPane(current.paneTree.root, current.paneTree.focusedPaneId);
  if (!focusedGroup) return activateSurfaceWorkspaceTab(current, surfaceId);
  const focusedTab = focusedGroup.tabIds
    .map((tabId) => current.tabsById[tabId])
    .find((tab) => tab?._tag === "Surface" && tab.surfaceId === surfaceId);
  return focusedTab
    ? activateWorkspaceTab(current, focusedTab.id)
    : addSurfaceTab(current, surfaceId);
}

function splitThreadWorkspaceTab(
  current: ThreadWorkspaceTabFields,
  input: {
    readonly paneId: PaneId;
    readonly tabId: PaneTabId;
    readonly direction: PaneSplitDirection;
    readonly mode: "copy" | "move";
  },
): ThreadWorkspaceTabFields {
  const sourceTab = current.tabsById[input.tabId];
  if (!sourceTab || (input.mode === "copy" && sourceTab._tag === "Thread")) return current;

  const targetPaneId = makePaneId(current.nextId);
  const splitId = makePaneSplitId(current.nextId + 1);
  const targetTabId = input.mode === "copy" ? makePaneTabId(current.nextId + 2) : input.tabId;
  const workspace = splitPaneTab(current.paneTree, {
    sourcePaneId: input.paneId,
    sourceTabId: input.tabId,
    targetTabId,
    targetPaneId,
    splitId,
    direction: input.direction,
    mode: input.mode,
  });
  if (workspace === current.paneTree) return current;
  return {
    paneTree: workspace,
    tabsById:
      input.mode === "copy"
        ? { ...current.tabsById, [targetTabId]: { ...sourceTab, id: targetTabId } }
        : current.tabsById,
    nextId: current.nextId + (input.mode === "copy" ? 3 : 2),
  };
}

function splitThreadWorkspacePane(
  current: ThreadWorkspaceTabFields,
  paneId: PaneId,
  direction: PaneSplitDirection,
): ThreadWorkspaceTabFields {
  const workspace = splitPane(current.paneTree, {
    sourcePaneId: paneId,
    targetPaneId: makePaneId(current.nextId),
    splitId: makePaneSplitId(current.nextId + 1),
    direction,
  });
  return workspace === current.paneTree
    ? current
    : { ...current, paneTree: workspace, nextId: current.nextId + 2 };
}

/** Reorders one thread-workspace tab within its current pane. */
function reorderThreadWorkspaceTab(
  current: ThreadWorkspaceTabFields,
  input: {
    readonly paneId: PaneId;
    readonly tabId: PaneTabId;
    readonly targetIndex: number;
  },
): ThreadWorkspaceTabFields {
  const tab = current.tabsById[input.tabId];
  const group = findPane(current.paneTree.root, input.paneId);
  if (!tab || tab._tag === "Thread" || !group) return current;
  const threadIndex = group.tabIds.findIndex((tabId) => current.tabsById[tabId]?._tag === "Thread");
  const targetIndex =
    threadIndex < 0 ? input.targetIndex : Math.max(threadIndex + 1, input.targetIndex);
  const workspace = reorderPaneTab(current.paneTree, { ...input, targetIndex });
  return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
}

/** Moves one thread-workspace tab into an existing pane. */
function moveThreadWorkspaceTabToPane(
  current: ThreadWorkspaceTabFields,
  input: {
    readonly sourcePaneId: PaneId;
    readonly targetPaneId: PaneId;
    readonly tabId: PaneTabId;
    readonly targetIndex?: number;
  },
): ThreadWorkspaceTabFields {
  const tab = current.tabsById[input.tabId];
  const targetGroup = findPane(current.paneTree.root, input.targetPaneId);
  if (!tab || !targetGroup) return current;
  const equivalentTargetTabId = targetGroup.tabIds.find((tabId) => {
    const candidate = current.tabsById[tabId];
    return candidate ? workspaceTabsShareContent(tab, candidate) : false;
  });
  if (equivalentTargetTabId) {
    const withoutSource = closeWorkspaceTab(current, input.tabId, input.sourcePaneId);
    const workspace = activatePaneTab(
      withoutSource.paneTree,
      input.targetPaneId,
      equivalentTargetTabId,
    );
    return workspace === withoutSource.paneTree
      ? withoutSource
      : { ...withoutSource, paneTree: workspace };
  }
  const threadIndex = targetGroup.tabIds.findIndex(
    (tabId) => current.tabsById[tabId]?._tag === "Thread",
  );
  const requestedTargetIndex =
    tab._tag === "Thread"
      ? 0
      : input.targetIndex === undefined || threadIndex < 0
        ? input.targetIndex
        : Math.max(threadIndex + 1, input.targetIndex);
  const workspace = moveTabToPane(current.paneTree, {
    ...input,
    ...(requestedTargetIndex !== undefined ? { targetIndex: requestedTargetIndex } : {}),
  });
  return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
}

/** Moves one thread-workspace tab into a new split around a target group. */
function moveThreadWorkspaceTabToSplit(
  current: ThreadWorkspaceTabFields,
  input: {
    readonly sourcePaneId: PaneId;
    readonly targetPaneId: PaneId;
    readonly tabId: PaneTabId;
    readonly direction: PaneSplitDirection;
  },
): ThreadWorkspaceTabFields {
  if (!current.tabsById[input.tabId]) return current;
  const workspace = moveTabToPaneSplit(current.paneTree, {
    sourcePaneId: input.sourcePaneId,
    sourceTabId: input.tabId,
    targetPaneId: input.targetPaneId,
    newPaneId: makePaneId(current.nextId),
    splitId: makePaneSplitId(current.nextId + 1),
    direction: input.direction,
  });
  return workspace === current.paneTree
    ? current
    : { ...current, paneTree: workspace, nextId: current.nextId + 2 };
}

/** Swaps two complete panes while preserving their tab contents. */
function swapThreadWorkspacePanes(
  current: ThreadWorkspaceTabFields,
  input: {
    readonly sourcePaneId: PaneId;
    readonly targetPaneId: PaneId;
  },
): ThreadWorkspaceTabFields {
  const workspace = swapPanes(current.paneTree, input.sourcePaneId, input.targetPaneId);
  return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
}

function closeThreadWorkspaceSurfaceTab(
  current: ThreadWorkspaceTabFields,
  paneId: PaneId,
  tabId: PaneTabId,
): ThreadWorkspaceTabFields {
  const tab = current.tabsById[tabId];
  return tab?._tag === "Surface" ? closeWorkspaceTab(current, tabId, paneId) : current;
}

function closeOtherThreadWorkspaceSurfaceTabs(
  current: ThreadWorkspaceTabFields,
  paneId: PaneId,
  tabId: PaneTabId,
): ThreadWorkspaceTabFields {
  const group = findPane(current.paneTree.root, paneId);
  if (!group || current.tabsById[tabId]?._tag !== "Surface") return current;
  return group.tabIds.reduce(
    (next, candidateId) =>
      candidateId !== tabId && next.tabsById[candidateId]?._tag === "Surface"
        ? closeWorkspaceTab(next, candidateId, paneId)
        : next,
    current,
  );
}

function closeThreadWorkspaceSurfaceTabsToRight(
  current: ThreadWorkspaceTabFields,
  paneId: PaneId,
  tabId: PaneTabId,
): ThreadWorkspaceTabFields {
  const group = findPane(current.paneTree.root, paneId);
  const tabIndex = group?.tabIds.indexOf(tabId) ?? -1;
  if (!group || tabIndex < 0) return current;
  return group.tabIds
    .slice(tabIndex + 1)
    .reduce(
      (next, candidateId) =>
        next.tabsById[candidateId]?._tag === "Surface"
          ? closeWorkspaceTab(next, candidateId, paneId)
          : next,
      current,
    );
}

function closeAllThreadWorkspaceSurfaceTabs(
  current: ThreadWorkspaceTabFields,
  paneId: PaneId,
): ThreadWorkspaceTabFields {
  const group = findPane(current.paneTree.root, paneId);
  if (!group) return current;
  return group.tabIds.reduce(
    (next, tabId) =>
      next.tabsById[tabId]?._tag === "Surface" ? closeWorkspaceTab(next, tabId, paneId) : next,
    current,
  );
}

export function findThreadWorkspaceTabGroup(
  current: ThreadWorkspaceTabFields,
  tabId: PaneTabId,
): PaneId | null {
  return getPanes(current.paneTree.root).find((group) => group.tabIds.includes(tabId))?.id ?? null;
}

export function findSurfaceTabs(
  current: ThreadWorkspaceTabFields,
  surfaceId: string,
): readonly Extract<ThreadWorkspaceTab, { _tag: "Surface" }>[] {
  return Object.values(current.tabsById).filter(
    (tab): tab is Extract<ThreadWorkspaceTab, { _tag: "Surface" }> =>
      tab._tag === "Surface" && tab.surfaceId === surfaceId,
  );
}

/**
 * Reveals a contextual surface beside the thread without creating duplicate
 * placements. Existing placements outside the thread pane keep the user's
 * layout; a placement inside the thread pane moves right so the conversation
 * remains visible.
 */
export function revealThreadWorkspaceSurfaceBesideThread(
  current: ThreadWorkspaceTabFields,
  surfaceId: string,
): ThreadWorkspaceTabFields {
  const threadTab = Object.values(current.tabsById).find((tab) => tab._tag === "Thread");
  const threadPaneId = threadTab ? findThreadWorkspaceTabGroup(current, threadTab.id) : null;
  const existingTabs = findSurfaceTabs(current, surfaceId);
  const existingOutsideThreadPane = existingTabs.find(
    (tab) => findThreadWorkspaceTabGroup(current, tab.id) !== threadPaneId,
  );

  if (existingOutsideThreadPane) {
    return restorePaneTree(activateWorkspaceTab(current, existingOutsideThreadPane.id));
  }

  if (!threadPaneId) {
    const revealed = existingTabs[0]
      ? activateWorkspaceTab(current, existingTabs[0].id)
      : addSurfaceTab(current, surfaceId);
    return restorePaneTree(revealed);
  }

  const rightPaneId = findAdjacentPanes(current.paneTree, threadPaneId).right;
  const existingThreadTab = existingTabs[0];
  if (existingThreadTab) {
    const moved = rightPaneId
      ? moveThreadWorkspaceTabToPane(current, {
          sourcePaneId: threadPaneId,
          targetPaneId: rightPaneId,
          tabId: existingThreadTab.id,
        })
      : moveThreadWorkspaceTabToSplit(current, {
          sourcePaneId: threadPaneId,
          targetPaneId: threadPaneId,
          tabId: existingThreadTab.id,
          direction: "right",
        });
    return restorePaneTree(moved);
  }

  const targetWorkspace = rightPaneId
    ? { ...current, paneTree: focusPane(current.paneTree, rightPaneId) }
    : splitThreadWorkspacePane(current, threadPaneId, "right");
  return restorePaneTree(addSurfaceTab(targetWorkspace, surfaceId));
}

function restorePaneTree(current: ThreadWorkspaceTabFields): ThreadWorkspaceTabFields {
  if (current.paneTree.maximizedPaneId === null) return current;
  return {
    ...current,
    paneTree: { ...current.paneTree, maximizedPaneId: null },
  };
}

function addSurfaceTab(
  current: ThreadWorkspaceTabFields,
  surfaceId: string,
  activate = true,
): ThreadWorkspaceTabFields {
  const tabId = makePaneTabId(current.nextId);
  const focusedGroup = findPane(current.paneTree.root, current.paneTree.focusedPaneId);
  const openedWorkspace = openPaneTab(current.paneTree, tabId);
  const workspace =
    !activate && focusedGroup?.activeTabId
      ? activatePaneTab(openedWorkspace, focusedGroup.id, focusedGroup.activeTabId)
      : openedWorkspace;
  return {
    paneTree: workspace,
    tabsById: {
      ...current.tabsById,
      [tabId]: { _tag: "Surface", id: tabId, surfaceId },
    },
    nextId: current.nextId + 1,
  };
}

function activateWorkspaceTab(
  current: ThreadWorkspaceTabFields,
  tabId: PaneTabId,
): ThreadWorkspaceTabFields {
  const paneId = findThreadWorkspaceTabGroup(current, tabId);
  if (!paneId) return current;
  const workspace = activatePaneTab(current.paneTree, paneId, tabId);
  return workspace === current.paneTree ? current : { ...current, paneTree: workspace };
}

function closeWorkspaceTab(
  current: ThreadWorkspaceTabFields,
  tabId: PaneTabId,
  knownGroupId?: PaneId,
): ThreadWorkspaceTabFields {
  const paneId = knownGroupId ?? findThreadWorkspaceTabGroup(current, tabId);
  if (!paneId) return withoutUnreferencedTabs(current);
  const workspace = closePaneTab(current.paneTree, paneId, tabId);
  return withoutUnreferencedTabs({ ...current, paneTree: workspace });
}

function withoutUnreferencedTabs(current: ThreadWorkspaceTabFields): ThreadWorkspaceTabFields {
  const referencedIds = new Set<string>(
    getPanes(current.paneTree.root).flatMap((group) => group.tabIds),
  );
  const tabsById = Object.fromEntries(
    Object.entries(current.tabsById).filter(([tabId]) => referencedIds.has(tabId)),
  );
  return Object.keys(tabsById).length === Object.keys(current.tabsById).length
    ? current
    : { ...current, tabsById };
}

function workspaceTabsShareContent(left: ThreadWorkspaceTab, right: ThreadWorkspaceTab): boolean {
  if (left._tag === "Thread" || right._tag === "Thread") {
    return left._tag === right._tag;
  }
  return left.surfaceId === right.surfaceId;
}

export function parsePersistedThreadWorkspaceTabs(input: unknown): {
  readonly byThreadKey: Readonly<Record<string, ThreadWorkspaceTabFields>>;
} {
  if (!input || typeof input !== "object" || !("byThreadKey" in input)) {
    return { byThreadKey: {} };
  }
  const rawByThreadKey = input.byThreadKey;
  if (!rawByThreadKey || typeof rawByThreadKey !== "object") {
    return { byThreadKey: {} };
  }
  const byThreadKey: Record<string, ThreadWorkspaceTabFields> = {};
  for (const [threadKey, rawWorkspace] of Object.entries(rawByThreadKey)) {
    const decoded = decodePersistedThreadWorkspaceTabFields(rawWorkspace);
    if (decoded._tag === "None") continue;
    const workspace = normalizePersistedThreadWorkspaceTabFields(decoded.value);
    if (workspace) byThreadKey[threadKey] = workspace;
  }
  return { byThreadKey };
}

function normalizePersistedThreadWorkspaceTabFields(
  persisted: typeof PersistedThreadWorkspaceTabFieldsSchema.Type,
): ThreadWorkspaceTabFields | null {
  const tabsById: Record<string, ThreadWorkspaceTab> = {};
  let threadTabCount = 0;
  for (const [tabKey, tab] of Object.entries(persisted.tabsById)) {
    const tabId = parsePaneTabId(tab.id);
    if (!tabId || tabKey !== tab.id) return null;
    if (tab._tag === "Thread") threadTabCount += 1;
    tabsById[tabKey] =
      tab._tag === "Thread"
        ? { _tag: "Thread", id: tabId }
        : { _tag: "Surface", id: tabId, surfaceId: tab.surfaceId };
  }
  if (threadTabCount !== 1) return null;

  const seenGroupIds = new Set<PaneId>();
  const seenSplitIds = new Set<PaneSplitId>();
  const referencedTabIds = new Set<PaneTabId>();
  const root = normalizePersistedEditorNode(persisted.paneTree.root, {
    seenGroupIds,
    seenSplitIds,
    referencedTabIds,
    tabsById,
  });
  const focusedPaneId = parsePaneId(persisted.paneTree.focusedPaneId);
  const maximizedPaneId = persisted.paneTree.maximizedPaneId
    ? parsePaneId(persisted.paneTree.maximizedPaneId)
    : null;
  if (
    !root ||
    !focusedPaneId ||
    !seenGroupIds.has(focusedPaneId) ||
    (persisted.paneTree.maximizedPaneId !== undefined &&
      persisted.paneTree.maximizedPaneId !== null &&
      (!maximizedPaneId || !seenGroupIds.has(maximizedPaneId))) ||
    referencedTabIds.size !== Object.keys(tabsById).length
  ) {
    return null;
  }
  return {
    paneTree: { root, focusedPaneId, maximizedPaneId },
    tabsById,
    nextId: Math.max(
      persisted.nextId,
      nextAvailableEditorId([...seenGroupIds, ...seenSplitIds, ...referencedTabIds]),
    ),
  };
}

function nextAvailableEditorId(ids: readonly string[]): number {
  let nextId = 1;
  for (const id of ids) {
    const suffix = id.slice(id.lastIndexOf(":") + 1);
    const numericId = Number(suffix);
    if (Number.isSafeInteger(numericId) && numericId >= nextId) {
      nextId = numericId + 1;
    }
  }
  return nextId;
}

function normalizePersistedEditorNode(
  node: PersistedPaneTreeNode,
  state: {
    readonly seenGroupIds: Set<PaneId>;
    readonly seenSplitIds: Set<PaneSplitId>;
    readonly referencedTabIds: Set<PaneTabId>;
    readonly tabsById: Readonly<Record<string, ThreadWorkspaceTab>>;
  },
): PaneTreeNode | null {
  if (node._tag === "Group") {
    const id = parsePaneId(node.id);
    if (!id || state.seenGroupIds.has(id)) return null;
    state.seenGroupIds.add(id);
    const tabIds: PaneTabId[] = [];
    for (const persistedTabId of node.tabIds) {
      const tabId = parsePaneTabId(persistedTabId);
      if (!tabId || !state.tabsById[tabId] || state.referencedTabIds.has(tabId)) {
        return null;
      }
      tabIds.push(tabId);
      state.referencedTabIds.add(tabId);
    }
    const activeTabId = node.activeTabId ? parsePaneTabId(node.activeTabId) : null;
    if ((node.activeTabId && !activeTabId) || (activeTabId && !tabIds.includes(activeTabId))) {
      return null;
    }
    if ((tabIds.length === 0) !== (activeTabId === null)) return null;
    return { _tag: "Group", id, tabIds, activeTabId };
  }

  const id = parsePaneSplitId(node.id);
  const ratio = clampPaneSplitRatio(node.ratio);
  if (!id || ratio === null || state.seenSplitIds.has(id)) return null;
  state.seenSplitIds.add(id);
  const first = normalizePersistedEditorNode(node.first, state);
  const second = normalizePersistedEditorNode(node.second, state);
  return first && second
    ? { _tag: "Split", id, orientation: node.orientation, ratio, first, second }
    : null;
}

function parsePaneId(value: string): PaneId | null {
  return isPaneId(value) ? value : null;
}

function parsePaneSplitId(value: string): PaneSplitId | null {
  return isPaneSplitId(value) ? value : null;
}

function parsePaneTabId(value: string): PaneTabId | null {
  return isPaneTabId(value) ? value : null;
}

function isPaneId(value: string): value is PaneId {
  return value.startsWith("pane:");
}

function isPaneSplitId(value: string): value is PaneSplitId {
  return value.startsWith("pane-split:");
}

function isPaneTabId(value: string): value is PaneTabId {
  return value.startsWith("pane-tab:");
}

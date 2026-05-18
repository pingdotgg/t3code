import { create } from "zustand";

import type { DiffRouteSearch } from "./diffRouteSearch";
import {
  type ChatSplitFocusDirection,
  type ChatSplitDropPlacement,
  type ChatSplitLayout,
  type ChatSplitNode,
  type ChatSplitNodeId,
  type ChatSplitOrientation,
  buildChatSplitLayoutFromTargets,
  closeLeaf,
  countLeafNodes,
  createInitialChatSplitLayout,
  findLeafNodeByTarget,
  focusLeaf as focusLeafInLayout,
  focusNeighbor as focusNeighborInLayout,
  getFocusedLeaf,
  getFocusedLeafTarget,
  getLeafNode,
  replaceLeafTarget as replaceLeafTargetInLayout,
  setLeafDiff,
  setSplitRatio as setSplitRatioInLayout,
  splitLeaf,
  splitLeafWithTarget,
  toggleLeafMaximized,
} from "./chatSplitLayout";
import type { ThreadRouteTarget } from "./threadRoutes";

function allTargetsShareSplitScope(targets: readonly ThreadRouteTarget[]): boolean {
  const [firstTarget, ...remainingTargets] = targets;
  if (!firstTarget) {
    return false;
  }
  if (firstTarget.kind !== "server") {
    return targets.length === 1;
  }
  return remainingTargets.every(
    (target) =>
      target.kind === "server" &&
      target.threadRef.environmentId === firstTarget.threadRef.environmentId,
  );
}

interface ChatSplitLayoutStoreState {
  layout: ChatSplitLayout | null;
  syncRouteTarget: (target: ThreadRouteTarget, diff?: DiffRouteSearch) => void;
  focusLeaf: (leafId: ChatSplitNodeId) => ThreadRouteTarget | null;
  focusNeighbor: (direction: ChatSplitFocusDirection) => ThreadRouteTarget | null;
  replaceLeafTarget: (
    leafId: ChatSplitNodeId,
    target: ThreadRouteTarget,
    diff?: DiffRouteSearch,
  ) => void;
  setFocusedLeafDiff: (diff: DiffRouteSearch) => void;
  splitFocusedLeaf: (orientation: "row" | "column") => void;
  unsplitFocusedLeaf: () => ThreadRouteTarget | null;
  openWorkspaceFromTargets: (
    targets: readonly ThreadRouteTarget[],
    orientation: ChatSplitOrientation,
  ) => ThreadRouteTarget | null;
  dropTargetIntoLeaf: (
    leafId: ChatSplitNodeId,
    target: ThreadRouteTarget,
    placement: ChatSplitDropPlacement,
  ) => ThreadRouteTarget | null;
  closeFocusedLeaf: () => ThreadRouteTarget | null;
  toggleFocusedLeafMaximized: () => void;
  setSplitRatio: (splitId: ChatSplitNodeId, ratio: number) => void;
}

function createNodeId(): ChatSplitNodeId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pane-${Math.random().toString(36).slice(2, 10)}`;
}

function updateActiveLayout(
  state: ChatSplitLayoutStoreState,
  updater: (layout: ChatSplitLayout) => ChatSplitLayout,
): ChatSplitLayoutStoreState {
  const activeLayout = state.layout;
  if (!activeLayout) {
    return state;
  }
  const nextLayout = updater(activeLayout);
  if (nextLayout === activeLayout) {
    return state;
  }
  return {
    ...state,
    layout: nextLayout,
  };
}

function createSingleLeafLayout(
  target: ThreadRouteTarget,
  diff?: DiffRouteSearch,
): ChatSplitLayout {
  return createInitialChatSplitLayout({
    leafId: createNodeId(),
    target,
    ...(diff !== undefined ? { diff } : {}),
  });
}

function getNonNullLeafTargets(layout: ChatSplitLayout): ThreadRouteTarget[] {
  return Object.values(layout.nodesById).flatMap((node) =>
    node.kind === "leaf" && node.target ? [node.target] : [],
  );
}

function syncRouteTargetIntoLayout(
  layout: ChatSplitLayout,
  target: ThreadRouteTarget,
  diff?: DiffRouteSearch,
): ChatSplitLayout {
  if (!allTargetsShareSplitScope([...getNonNullLeafTargets(layout), target])) {
    return createSingleLeafLayout(target, diff);
  }

  const existingLeaf = findLeafNodeByTarget(layout, target);
  if (existingLeaf) {
    const focusedLayout = focusLeafInLayout(layout, existingLeaf.id);
    const nextLayout = replaceLeafTargetInLayout(focusedLayout, existingLeaf.id, target, diff);
    if (nextLayout.maximizedLeafId && nextLayout.maximizedLeafId !== existingLeaf.id) {
      return {
        ...nextLayout,
        maximizedLeafId: null,
      };
    }
    return nextLayout;
  }

  const focusedLeaf = getFocusedLeaf(layout);
  if (!focusedLeaf) {
    return createSingleLeafLayout(target, diff);
  }

  return replaceLeafTargetInLayout(layout, focusedLeaf.id, target, diff);
}

export function selectActiveChatSplitLayout(
  state: Pick<ChatSplitLayoutStoreState, "layout">,
): ChatSplitLayout | null {
  return state.layout;
}

export function selectChatSplitNode(
  state: Pick<ChatSplitLayoutStoreState, "layout">,
  nodeId: ChatSplitNodeId,
): ChatSplitNode | null {
  return selectActiveChatSplitLayout(state)?.nodesById[nodeId] ?? null;
}

export const useChatSplitLayoutStore = create<ChatSplitLayoutStoreState>((set, get) => ({
  layout: null,
  syncRouteTarget: (target, diff) => {
    set((state) => {
      const activeLayout = selectActiveChatSplitLayout(state);
      const nextLayout = activeLayout
        ? syncRouteTargetIntoLayout(activeLayout, target, diff)
        : createSingleLeafLayout(target, diff);
      if (nextLayout === activeLayout) {
        return state;
      }
      return {
        ...state,
        layout: nextLayout,
      };
    });
  },
  focusLeaf: (leafId) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    const leaf = activeLayout ? getLeafNode(activeLayout, leafId) : null;
    if (!leaf) {
      return null;
    }
    set((state) => updateActiveLayout(state, (layout) => focusLeafInLayout(layout, leafId)));
    return leaf.target;
  },
  focusNeighbor: (direction) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout) {
      return null;
    }

    const nextLayout = focusNeighborInLayout(activeLayout, direction);
    const nextTarget = nextLayout === activeLayout ? null : getFocusedLeafTarget(nextLayout);
    if (!nextTarget) {
      return null;
    }
    set((state) => updateActiveLayout(state, () => nextLayout));
    return nextTarget;
  },
  replaceLeafTarget: (leafId, target, diff) => {
    set((state) =>
      updateActiveLayout(state, (layout) =>
        replaceLeafTargetInLayout(layout, leafId, target, diff),
      ),
    );
  },
  setFocusedLeafDiff: (diff) => {
    set((state) =>
      updateActiveLayout(state, (layout) => setLeafDiff(layout, layout.focusedLeafId, diff)),
    );
  },
  splitFocusedLeaf: (orientation) => {
    set((state) =>
      updateActiveLayout(state, (layout) =>
        splitLeaf(layout, layout.focusedLeafId, orientation, createNodeId),
      ),
    );
  },
  unsplitFocusedLeaf: () => {
    const activeLayout = selectActiveChatSplitLayout(get());
    const focusedLeaf = activeLayout ? getFocusedLeaf(activeLayout) : null;
    if (!focusedLeaf?.target) {
      return null;
    }
    const target = focusedLeaf.target;
    const diff = focusedLeaf.diff;

    set((state) => updateActiveLayout(state, () => createSingleLeafLayout(target, diff)));
    return target;
  },
  openWorkspaceFromTargets: (targets, orientation) => {
    const [firstTarget] = targets;
    if (!firstTarget || !allTargetsShareSplitScope(targets)) {
      return null;
    }

    const nextLayout = buildChatSplitLayoutFromTargets({
      targets,
      orientation,
      createId: createNodeId,
    });
    if (!nextLayout) {
      return null;
    }

    const focusedTarget = getFocusedLeafTarget(nextLayout);
    if (!focusedTarget) {
      return null;
    }

    set((state) => ({
      ...state,
      layout: nextLayout,
    }));

    return focusedTarget;
  },
  dropTargetIntoLeaf: (leafId, target, placement) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout) {
      return null;
    }

    const existingLeaf = findLeafNodeByTarget(activeLayout, target);
    if (existingLeaf) {
      set((state) =>
        updateActiveLayout(state, (layout) => focusLeafInLayout(layout, existingLeaf.id)),
      );
      return target;
    }

    const targetLeaf = getLeafNode(activeLayout, leafId);
    if (!targetLeaf) {
      return null;
    }

    if (!targetLeaf.target) {
      set((state) =>
        updateActiveLayout(state, (layout) => replaceLeafTargetInLayout(layout, leafId, target)),
      );
      return target;
    }

    set((state) =>
      updateActiveLayout(state, (layout) =>
        splitLeafWithTarget(layout, leafId, target, placement, createNodeId),
      ),
    );
    return target;
  },
  closeFocusedLeaf: () => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout || countLeafNodes(activeLayout) <= 1) {
      return null;
    }

    const nextLayout = closeLeaf(activeLayout, activeLayout.focusedLeafId);
    const nextTarget = getFocusedLeafTarget(nextLayout);
    set((state) => updateActiveLayout(state, () => nextLayout));
    return nextTarget;
  },
  toggleFocusedLeafMaximized: () => {
    set((state) =>
      updateActiveLayout(state, (layout) => toggleLeafMaximized(layout, layout.focusedLeafId)),
    );
  },
  setSplitRatio: (splitId, ratio) => {
    set((state) =>
      updateActiveLayout(state, (layout) => setSplitRatioInLayout(layout, splitId, ratio)),
    );
  },
}));

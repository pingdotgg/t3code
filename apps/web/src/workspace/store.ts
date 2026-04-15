import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  readBrowserWorkspaceDocument,
  writeBrowserWorkspaceDocument,
} from "../clientPersistenceStorage";
import { randomUUID } from "../lib/utils";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import {
  createEmptyWorkspaceDocument,
  isWorkspaceDocument,
  normalizeWorkspaceSplitSizes,
  routeTargetForSurface,
  sameTerminalSurfaceInput,
  sameThreadSurfaceInput,
  type TerminalSurfaceInput,
  type ThreadSurfaceInput,
  type WorkspaceAxis,
  type WorkspaceDirection,
  type WorkspaceDocument,
  type WorkspaceNode,
  type WorkspacePlacementTarget,
  type WorkspaceSurfaceInstance,
  type WorkspaceWindow,
} from "./types";

type OpenThreadDisposition = "focus-or-tab" | "new-tab" | "split-right" | "split-down";
type OpenTerminalDisposition = OpenThreadDisposition;

const WORKSPACE_PERSIST_DEBOUNCE_MS = 150;
const WORKSPACE_RESIZE_STEP = 0.08;
const WORKSPACE_MIN_RESIZE_FRACTION = 0.12;

let persistTimer: number | null = null;
const WINDOW_RECT_EPSILON = 0.001;

function scheduleWorkspacePersistence(document: WorkspaceDocument): void {
  if (typeof window === "undefined") {
    return;
  }

  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
  }

  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    writeBrowserWorkspaceDocument(document);
  }, WORKSPACE_PERSIST_DEBOUNCE_MS);
}

function nextWorkspaceId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function nextTerminalSessionId(): string {
  return `terminal-${randomUUID()}`;
}

function equalSplitSizes(childCount: number): number[] {
  return normalizeWorkspaceSplitSizes(undefined, childCount);
}

function createThreadSurface(input: ThreadSurfaceInput): WorkspaceSurfaceInstance {
  return {
    id: nextWorkspaceId("surface"),
    kind: "thread",
    input,
  };
}

function createTerminalSurface(input: TerminalSurfaceInput): WorkspaceSurfaceInstance {
  return {
    id: nextWorkspaceId("surface"),
    kind: "terminal",
    input,
  };
}

function duplicateSurface(surface: WorkspaceSurfaceInstance): WorkspaceSurfaceInstance {
  if (surface.kind === "thread") {
    return createThreadSurface(surface.input);
  }

  return createTerminalSurface({
    ...surface.input,
    terminalId: nextTerminalSessionId(),
  });
}

function cloneWindow(window: WorkspaceWindow): WorkspaceWindow {
  return {
    ...window,
    tabIds: [...window.tabIds],
  };
}

function getWindowBySurfaceId(
  document: WorkspaceDocument,
  surfaceId: string,
): { windowId: string; window: WorkspaceWindow } | null {
  for (const [windowId, window] of Object.entries(document.windowsById)) {
    if (window.tabIds.includes(surfaceId)) {
      return { windowId, window };
    }
  }

  return null;
}

interface WorkspaceWindowRect {
  windowId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function getWindowNodeByWindowId(
  document: WorkspaceDocument,
  windowId: string,
): { nodeId: string; node: Extract<WorkspaceNode, { kind: "window" }> } | null {
  for (const [nodeId, node] of Object.entries(document.nodesById)) {
    if (node.kind === "window" && node.windowId === windowId) {
      return { nodeId, node };
    }
  }

  return null;
}

function collectWindowRects(
  document: WorkspaceDocument,
  nodeId: string | null,
  rect: Omit<WorkspaceWindowRect, "windowId">,
  rects: WorkspaceWindowRect[],
): void {
  if (!nodeId) {
    return;
  }

  const node = document.nodesById[nodeId];
  if (!node) {
    return;
  }

  if (node.kind === "window") {
    rects.push({
      windowId: node.windowId,
      ...rect,
    });
    return;
  }

  const sizes = normalizeWorkspaceSplitSizes(node.sizes, node.childIds.length);
  let cursor = node.axis === "x" ? rect.left : rect.top;

  for (const [index, childId] of node.childIds.entries()) {
    const size = sizes[index] ?? 0;
    if (node.axis === "x") {
      const nextCursor = cursor + (rect.right - rect.left) * size;
      collectWindowRects(
        document,
        childId,
        {
          left: cursor,
          top: rect.top,
          right: nextCursor,
          bottom: rect.bottom,
        },
        rects,
      );
      cursor = nextCursor;
      continue;
    }

    const nextCursor = cursor + (rect.bottom - rect.top) * size;
    collectWindowRects(
      document,
      childId,
      {
        left: rect.left,
        top: cursor,
        right: rect.right,
        bottom: nextCursor,
      },
      rects,
    );
    cursor = nextCursor;
  }
}

function getWorkspaceWindowRects(document: WorkspaceDocument): WorkspaceWindowRect[] {
  const rects: WorkspaceWindowRect[] = [];
  collectWindowRects(
    document,
    document.rootNodeId,
    {
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    },
    rects,
  );
  return rects;
}

function getOrderedWorkspaceWindowIds(document: WorkspaceDocument): string[] {
  return getWorkspaceWindowRects(document)
    .toSorted((left, right) => {
      const topDelta = left.top - right.top;
      if (Math.abs(topDelta) > WINDOW_RECT_EPSILON) {
        return topDelta;
      }
      return left.left - right.left;
    })
    .map((rect) => rect.windowId);
}

function axisOverlapLength(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function findAdjacentWindowId(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  direction: WorkspaceDirection,
): string | null {
  if (!sourceWindowId) {
    return null;
  }

  const rects = getWorkspaceWindowRects(document);
  const sourceRect = rects.find((rect) => rect.windowId === sourceWindowId);
  if (!sourceRect) {
    return null;
  }

  let bestMatch: { windowId: string; gap: number; overlap: number } | null = null;

  for (const candidate of rects) {
    if (candidate.windowId === sourceWindowId) {
      continue;
    }

    let gap: number;
    let overlap: number;

    switch (direction) {
      case "left":
        gap = sourceRect.left - candidate.right;
        overlap = axisOverlapLength(
          sourceRect.top,
          sourceRect.bottom,
          candidate.top,
          candidate.bottom,
        );
        break;
      case "right":
        gap = candidate.left - sourceRect.right;
        overlap = axisOverlapLength(
          sourceRect.top,
          sourceRect.bottom,
          candidate.top,
          candidate.bottom,
        );
        break;
      case "up":
        gap = sourceRect.top - candidate.bottom;
        overlap = axisOverlapLength(
          sourceRect.left,
          sourceRect.right,
          candidate.left,
          candidate.right,
        );
        break;
      case "down":
        gap = candidate.top - sourceRect.bottom;
        overlap = axisOverlapLength(
          sourceRect.left,
          sourceRect.right,
          candidate.left,
          candidate.right,
        );
        break;
    }

    if (gap < -WINDOW_RECT_EPSILON || overlap <= WINDOW_RECT_EPSILON) {
      continue;
    }

    const normalizedGap = Math.max(0, gap);
    if (
      !bestMatch ||
      normalizedGap < bestMatch.gap - WINDOW_RECT_EPSILON ||
      (Math.abs(normalizedGap - bestMatch.gap) <= WINDOW_RECT_EPSILON &&
        overlap > bestMatch.overlap + WINDOW_RECT_EPSILON)
    ) {
      bestMatch = {
        windowId: candidate.windowId,
        gap: normalizedGap,
        overlap,
      };
    }
  }

  return bestMatch?.windowId ?? null;
}

function findParentNode(
  document: WorkspaceDocument,
  childNodeId: string,
): { parentId: string; parent: Extract<WorkspaceNode, { kind: "split" }>; index: number } | null {
  for (const [parentId, node] of Object.entries(document.nodesById)) {
    if (node.kind !== "split") {
      continue;
    }

    const index = node.childIds.indexOf(childNodeId);
    if (index >= 0) {
      return { parentId, parent: node, index };
    }
  }

  return null;
}

function firstWindowId(document: WorkspaceDocument): string | null {
  if (document.focusedWindowId && document.windowsById[document.focusedWindowId]) {
    return document.focusedWindowId;
  }

  return Object.keys(document.windowsById)[0] ?? null;
}

function focusWindowByStep(document: WorkspaceDocument, step: -1 | 1): WorkspaceDocument {
  const windowIds = getOrderedWorkspaceWindowIds(document);
  if (windowIds.length <= 1) {
    return document;
  }

  const sourceWindowId = firstWindowId(document);
  if (!sourceWindowId) {
    return document;
  }

  const sourceIndex = windowIds.indexOf(sourceWindowId);
  if (sourceIndex < 0) {
    return document;
  }

  const nextIndex = (sourceIndex + step + windowIds.length) % windowIds.length;
  return setFocusedWindow(document, windowIds[nextIndex] ?? null);
}

function getFocusedSurface(document: WorkspaceDocument): WorkspaceSurfaceInstance | null {
  const windowId = firstWindowId(document);
  if (!windowId) {
    return null;
  }
  const window = document.windowsById[windowId];
  const surfaceId = window?.activeTabId ?? null;
  return surfaceId ? (document.surfacesById[surfaceId] ?? null) : null;
}

function setFocusedWindow(document: WorkspaceDocument, windowId: string | null): WorkspaceDocument {
  if (document.focusedWindowId === windowId && document.mobileActiveWindowId === windowId) {
    return document;
  }

  return {
    ...document,
    focusedWindowId: windowId,
    mobileActiveWindowId: windowId,
  };
}

function focusSurfaceById(document: WorkspaceDocument, surfaceId: string): WorkspaceDocument {
  const located = getWindowBySurfaceId(document, surfaceId);
  if (!located) {
    return document;
  }

  if (
    located.window.activeTabId === surfaceId &&
    document.focusedWindowId === located.windowId &&
    document.mobileActiveWindowId === located.windowId
  ) {
    return document;
  }

  const nextWindow = cloneWindow(located.window);
  nextWindow.activeTabId = surfaceId;

  return {
    ...document,
    windowsById: {
      ...document.windowsById,
      [located.windowId]: nextWindow,
    },
    focusedWindowId: located.windowId,
    mobileActiveWindowId: located.windowId,
  };
}

function insertSurfaceIntoWindow(
  document: WorkspaceDocument,
  windowId: string | null,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (!windowId || !document.windowsById[windowId]) {
    const nextWindowId = nextWorkspaceId("window");
    const nextNodeId = nextWorkspaceId("node");
    return {
      ...document,
      rootNodeId: nextNodeId,
      nodesById: {
        [nextNodeId]: {
          id: nextNodeId,
          kind: "window",
          windowId: nextWindowId,
        },
      },
      windowsById: {
        [nextWindowId]: {
          id: nextWindowId,
          tabIds: [surface.id],
          activeTabId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const currentWindow = document.windowsById[windowId];
  const nextWindow = cloneWindow(currentWindow);
  nextWindow.tabIds = [...nextWindow.tabIds, surface.id];
  nextWindow.activeTabId = surface.id;

  return {
    ...document,
    windowsById: {
      ...document.windowsById,
      [windowId]: nextWindow,
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: windowId,
    mobileActiveWindowId: windowId,
  };
}

function clampTabIndex(window: WorkspaceWindow, index: number): number {
  return Math.max(0, Math.min(index, window.tabIds.length));
}

function insertSurfaceIntoWindowAt(
  document: WorkspaceDocument,
  windowId: string | null,
  surface: WorkspaceSurfaceInstance,
  index: number,
): WorkspaceDocument {
  if (!windowId || !document.windowsById[windowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const currentWindow = document.windowsById[windowId];
  const nextWindow = cloneWindow(currentWindow);
  const nextTabIds = [...nextWindow.tabIds];
  nextTabIds.splice(clampTabIndex(currentWindow, index), 0, surface.id);
  nextWindow.tabIds = nextTabIds;
  nextWindow.activeTabId = surface.id;

  return {
    ...document,
    windowsById: {
      ...document.windowsById,
      [windowId]: nextWindow,
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: windowId,
    mobileActiveWindowId: windowId,
  };
}

function placementToSplitParams(placement: "left" | "right" | "top" | "bottom"): {
  axis: WorkspaceAxis;
  insertBefore: boolean;
} {
  switch (placement) {
    case "left":
      return { axis: "x", insertBefore: true };
    case "right":
      return { axis: "x", insertBefore: false };
    case "top":
      return { axis: "y", insertBefore: true };
    case "bottom":
      return { axis: "y", insertBefore: false };
  }
}

function splitWindowWithSurface(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  axis: WorkspaceAxis,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (!sourceWindowId || !document.windowsById[sourceWindowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  if (!sourceNode) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const parent = findParentNode(document, sourceNode.nodeId);
  const nextWindowId = nextWorkspaceId("window");
  const nextWindowNodeId = nextWorkspaceId("node");
  const nextWindowNode: WorkspaceNode = {
    id: nextWindowNodeId,
    kind: "window",
    windowId: nextWindowId,
  };
  const nextNodesById: Record<string, WorkspaceNode> = {
    ...document.nodesById,
    [nextWindowNodeId]: nextWindowNode,
  };

  if (parent && parent.parent.axis === axis && parent.parent.sizingMode === "auto") {
    const nextChildIds = [
      ...parent.parent.childIds.slice(0, parent.index + 1),
      nextWindowNodeId,
      ...parent.parent.childIds.slice(parent.index + 1),
    ];
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: nextChildIds,
      sizes: equalSplitSizes(nextChildIds.length),
      sizingMode: "auto",
    };

    return {
      ...document,
      nodesById: nextNodesById,
      windowsById: {
        ...document.windowsById,
        [nextWindowId]: {
          id: nextWindowId,
          tabIds: [surface.id],
          activeTabId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const nextSplitNodeId = nextWorkspaceId("node");
  const nextSplitNode: WorkspaceNode = {
    id: nextSplitNodeId,
    kind: "split",
    axis,
    childIds: [sourceNode.nodeId, nextWindowNodeId],
    sizes: equalSplitSizes(2),
    sizingMode: "auto",
  };
  nextNodesById[nextSplitNodeId] = nextSplitNode;

  let nextRootNodeId = document.rootNodeId;
  if (!parent) {
    nextRootNodeId = nextSplitNodeId;
  } else {
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: parent.parent.childIds.map((childId, index) =>
        index === parent.index ? nextSplitNodeId : childId,
      ),
    };
  }

  return {
    ...document,
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
    windowsById: {
      ...document.windowsById,
      [nextWindowId]: {
        id: nextWindowId,
        tabIds: [surface.id],
        activeTabId: surface.id,
      },
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: nextWindowId,
    mobileActiveWindowId: nextWindowId,
  };
}

function splitWindowWithSurfaceAtEdge(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  placement: "left" | "right" | "top" | "bottom",
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (!sourceWindowId || !document.windowsById[sourceWindowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const { axis, insertBefore } = placementToSplitParams(placement);
  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  if (!sourceNode) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const parent = findParentNode(document, sourceNode.nodeId);
  const nextWindowId = nextWorkspaceId("window");
  const nextWindowNodeId = nextWorkspaceId("node");
  const nextWindowNode: WorkspaceNode = {
    id: nextWindowNodeId,
    kind: "window",
    windowId: nextWindowId,
  };
  const nextNodesById: Record<string, WorkspaceNode> = {
    ...document.nodesById,
    [nextWindowNodeId]: nextWindowNode,
  };

  if (parent && parent.parent.axis === axis && parent.parent.sizingMode === "auto") {
    const insertIndex = insertBefore ? parent.index : parent.index + 1;
    const nextChildIds = [
      ...parent.parent.childIds.slice(0, insertIndex),
      nextWindowNodeId,
      ...parent.parent.childIds.slice(insertIndex),
    ];
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: nextChildIds,
      sizes: equalSplitSizes(nextChildIds.length),
      sizingMode: "auto",
    };

    return {
      ...document,
      nodesById: nextNodesById,
      windowsById: {
        ...document.windowsById,
        [nextWindowId]: {
          id: nextWindowId,
          tabIds: [surface.id],
          activeTabId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const nextSplitNodeId = nextWorkspaceId("node");
  const childIds = insertBefore
    ? [nextWindowNodeId, sourceNode.nodeId]
    : [sourceNode.nodeId, nextWindowNodeId];
  const nextSplitNode: WorkspaceNode = {
    id: nextSplitNodeId,
    kind: "split",
    axis,
    childIds,
    sizes: equalSplitSizes(2),
    sizingMode: "auto",
  };
  nextNodesById[nextSplitNodeId] = nextSplitNode;

  let nextRootNodeId = document.rootNodeId;
  if (!parent) {
    nextRootNodeId = nextSplitNodeId;
  } else {
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: parent.parent.childIds.map((childId, index) =>
        index === parent.index ? nextSplitNodeId : childId,
      ),
    };
  }

  return {
    ...document,
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
    windowsById: {
      ...document.windowsById,
      [nextWindowId]: {
        id: nextWindowId,
        tabIds: [surface.id],
        activeTabId: surface.id,
      },
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: nextWindowId,
    mobileActiveWindowId: nextWindowId,
  };
}

function setWorkspaceSplitNodeSizes(
  document: WorkspaceDocument,
  nodeId: string,
  sizes: number[],
): WorkspaceDocument {
  const node = document.nodesById[nodeId];
  if (!node || node.kind !== "split") {
    return document;
  }

  const currentSizes = normalizeWorkspaceSplitSizes(node.sizes, node.childIds.length);
  const nextSizes = normalizeWorkspaceSplitSizes(sizes, node.childIds.length);
  const changed = currentSizes.some(
    (size, index) => Math.abs(size - (nextSizes[index] ?? 0)) > 0.001,
  );
  if (!changed) {
    return document;
  }

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [nodeId]: {
        ...node,
        sizes: nextSizes,
        sizingMode: "manual",
      },
    },
  };
}

function removeChildFromSplitNode(
  node: Extract<WorkspaceNode, { kind: "split" }>,
  removeIndex: number,
): Extract<WorkspaceNode, { kind: "split" }> {
  const nextChildIds = node.childIds.filter((_, index) => index !== removeIndex);
  const nextSizes =
    node.sizingMode === "manual"
      ? normalizeWorkspaceSplitSizes(
          node.sizes.filter((_, index) => index !== removeIndex),
          nextChildIds.length,
        )
      : equalSplitSizes(nextChildIds.length);

  return {
    ...node,
    childIds: nextChildIds,
    sizes: nextSizes,
  };
}

function collapseSplitNode(
  nodesById: Record<string, WorkspaceNode>,
  splitNodeId: string,
): { nodesById: Record<string, WorkspaceNode>; replacementNodeId: string | null } {
  const splitNode = nodesById[splitNodeId];
  if (!splitNode || splitNode.kind !== "split") {
    return { nodesById, replacementNodeId: null };
  }

  if (splitNode.childIds.length === 0) {
    const { [splitNodeId]: _removed, ...rest } = nodesById;
    return { nodesById: rest, replacementNodeId: null };
  }

  if (splitNode.childIds.length > 1) {
    return { nodesById, replacementNodeId: splitNodeId };
  }

  const replacementNodeId = splitNode.childIds[0] ?? null;
  const { [splitNodeId]: _removed, ...rest } = nodesById;
  return { nodesById: rest, replacementNodeId };
}

function removeWindowNodeFromTree(
  document: WorkspaceDocument,
  windowId: string,
): Pick<WorkspaceDocument, "rootNodeId" | "nodesById"> {
  const windowNode = getWindowNodeByWindowId(document, windowId);
  if (!windowNode) {
    return {
      rootNodeId: document.rootNodeId,
      nodesById: document.nodesById,
    };
  }

  let nextNodesById = { ...document.nodesById };
  const { [windowNode.nodeId]: _removedWindowNode, ...nodesWithoutWindowNode } = nextNodesById;
  nextNodesById = nodesWithoutWindowNode;
  let nextRootNodeId = document.rootNodeId;
  let currentNodeId = windowNode.nodeId;

  while (true) {
    const parent = findParentNode(
      { ...document, nodesById: nextNodesById, rootNodeId: nextRootNodeId },
      currentNodeId,
    );
    if (!parent) {
      if (nextRootNodeId === currentNodeId) {
        nextRootNodeId = null;
      }
      break;
    }

    const nextParentNode = removeChildFromSplitNode(parent.parent, parent.index);
    const nextChildIds = nextParentNode.childIds;
    if (nextChildIds.length > 1) {
      nextNodesById[parent.parentId] = nextParentNode;
      break;
    }

    const collapsed = collapseSplitNode(
      {
        ...nextNodesById,
        [parent.parentId]: nextParentNode,
      },
      parent.parentId,
    );
    nextNodesById = collapsed.nodesById;
    if (document.rootNodeId === parent.parentId || nextRootNodeId === parent.parentId) {
      nextRootNodeId = collapsed.replacementNodeId;
    } else {
      const grandparent = findParentNode(
        { ...document, nodesById: nextNodesById, rootNodeId: nextRootNodeId },
        parent.parentId,
      );
      const replacementNodeId = collapsed.replacementNodeId;
      if (grandparent && replacementNodeId) {
        nextNodesById[grandparent.parentId] = {
          ...grandparent.parent,
          childIds: grandparent.parent.childIds.map((childId) =>
            childId === parent.parentId ? replacementNodeId : childId,
          ),
        };
      }
    }
    currentNodeId = parent.parentId;
  }

  return {
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
  };
}

function closeSurfaceById(document: WorkspaceDocument, surfaceId: string): WorkspaceDocument {
  const located = getWindowBySurfaceId(document, surfaceId);
  if (!located) {
    return document;
  }

  const nextWindow = cloneWindow(located.window);
  nextWindow.tabIds = nextWindow.tabIds.filter((tabId) => tabId !== surfaceId);
  if (nextWindow.activeTabId === surfaceId) {
    const closedIndex = located.window.tabIds.indexOf(surfaceId);
    nextWindow.activeTabId =
      nextWindow.tabIds[Math.min(closedIndex, nextWindow.tabIds.length - 1)] ??
      nextWindow.tabIds[0] ??
      null;
  }

  const nextSurfacesById = { ...document.surfacesById };
  delete nextSurfacesById[surfaceId];

  if (nextWindow.tabIds.length > 0) {
    return {
      ...document,
      windowsById: {
        ...document.windowsById,
        [located.windowId]: nextWindow,
      },
      surfacesById: nextSurfacesById,
      focusedWindowId: located.windowId,
      mobileActiveWindowId: located.windowId,
    };
  }

  const nextWindowsById = { ...document.windowsById };
  delete nextWindowsById[located.windowId];
  const nextTree = removeWindowNodeFromTree(document, located.windowId);
  const fallbackWindowId = Object.keys(nextWindowsById)[0] ?? null;

  return {
    ...document,
    rootNodeId: nextTree.rootNodeId,
    nodesById: nextTree.nodesById,
    windowsById: nextWindowsById,
    surfacesById: nextSurfacesById,
    focusedWindowId: fallbackWindowId,
    mobileActiveWindowId: fallbackWindowId,
  };
}

function closeWindowById(document: WorkspaceDocument, windowId: string): WorkspaceDocument {
  const window = document.windowsById[windowId];
  if (!window) {
    return document;
  }

  const nextSurfacesById = { ...document.surfacesById };
  for (const surfaceId of window.tabIds) {
    delete nextSurfacesById[surfaceId];
  }

  const nextWindowsById = { ...document.windowsById };
  delete nextWindowsById[windowId];

  const nextTree = removeWindowNodeFromTree(document, windowId);
  const fallbackWindowId =
    findAdjacentWindowId(document, windowId, "right") ??
    findAdjacentWindowId(document, windowId, "left") ??
    findAdjacentWindowId(document, windowId, "down") ??
    findAdjacentWindowId(document, windowId, "up") ??
    Object.keys(nextWindowsById)[0] ??
    null;

  const focusedWindowId =
    fallbackWindowId && nextWindowsById[fallbackWindowId] ? fallbackWindowId : null;

  return {
    ...document,
    rootNodeId: nextTree.rootNodeId,
    nodesById: nextTree.nodesById,
    windowsById: nextWindowsById,
    surfacesById: nextSurfacesById,
    focusedWindowId,
    mobileActiveWindowId: focusedWindowId,
  };
}

function detachSurfaceFromWindow(
  document: WorkspaceDocument,
  surfaceId: string,
): {
  document: WorkspaceDocument;
  sourceWindowId: string | null;
  surface: WorkspaceSurfaceInstance | null;
} {
  const surface = document.surfacesById[surfaceId] ?? null;
  const located = getWindowBySurfaceId(document, surfaceId);
  if (!surface || !located) {
    return {
      document,
      sourceWindowId: null,
      surface,
    };
  }

  const nextWindow = cloneWindow(located.window);
  nextWindow.tabIds = nextWindow.tabIds.filter((tabId) => tabId !== surfaceId);
  if (nextWindow.activeTabId === surfaceId) {
    const removedIndex = located.window.tabIds.indexOf(surfaceId);
    nextWindow.activeTabId =
      nextWindow.tabIds[Math.min(removedIndex, nextWindow.tabIds.length - 1)] ??
      nextWindow.tabIds[0] ??
      null;
  }

  if (nextWindow.tabIds.length > 0) {
    return {
      document: {
        ...document,
        windowsById: {
          ...document.windowsById,
          [located.windowId]: nextWindow,
        },
      },
      sourceWindowId: located.windowId,
      surface,
    };
  }

  const nextWindowsById = { ...document.windowsById };
  delete nextWindowsById[located.windowId];
  const nextTree = removeWindowNodeFromTree(document, located.windowId);
  const fallbackWindowId = Object.keys(nextWindowsById)[0] ?? null;

  return {
    document: {
      ...document,
      rootNodeId: nextTree.rootNodeId,
      nodesById: nextTree.nodesById,
      windowsById: nextWindowsById,
      focusedWindowId: fallbackWindowId,
      mobileActiveWindowId: fallbackWindowId,
    },
    sourceWindowId: located.windowId,
    surface,
  };
}

function moveSurfaceToTabIndex(
  document: WorkspaceDocument,
  surfaceId: string,
  targetWindowId: string,
  targetIndex: number,
): WorkspaceDocument {
  const targetWindow = document.windowsById[targetWindowId];
  const source = getWindowBySurfaceId(document, surfaceId);
  if (!targetWindow || !source) {
    return document;
  }

  if (source.windowId === targetWindowId) {
    const fromIndex = source.window.tabIds.indexOf(surfaceId);
    if (fromIndex < 0) {
      return document;
    }
    const filteredTabIds = source.window.tabIds.filter((tabId) => tabId !== surfaceId);
    const boundedIndex = Math.max(0, Math.min(targetIndex, filteredTabIds.length));
    filteredTabIds.splice(boundedIndex, 0, surfaceId);
    const unchanged =
      filteredTabIds.length === source.window.tabIds.length &&
      filteredTabIds.every((tabId, index) => tabId === source.window.tabIds[index]) &&
      source.window.activeTabId === surfaceId &&
      document.focusedWindowId === targetWindowId &&
      document.mobileActiveWindowId === targetWindowId;
    if (unchanged) {
      return document;
    }
    return {
      ...document,
      windowsById: {
        ...document.windowsById,
        [targetWindowId]: {
          ...source.window,
          tabIds: filteredTabIds,
          activeTabId: surfaceId,
        },
      },
      focusedWindowId: targetWindowId,
      mobileActiveWindowId: targetWindowId,
    };
  }

  const detached = detachSurfaceFromWindow(document, surfaceId);
  const nextTargetWindow = detached.document.windowsById[targetWindowId];
  if (!nextTargetWindow) {
    return document;
  }
  const nextTabIds = [...nextTargetWindow.tabIds];
  nextTabIds.splice(clampTabIndex(nextTargetWindow, targetIndex), 0, surfaceId);

  return {
    ...detached.document,
    windowsById: {
      ...detached.document.windowsById,
      [targetWindowId]: {
        ...nextTargetWindow,
        tabIds: nextTabIds,
        activeTabId: surfaceId,
      },
    },
    focusedWindowId: targetWindowId,
    mobileActiveWindowId: targetWindowId,
  };
}

function moveSurfaceToEdge(
  document: WorkspaceDocument,
  surfaceId: string,
  targetWindowId: string,
  placement: "left" | "right" | "top" | "bottom",
): WorkspaceDocument {
  const source = getWindowBySurfaceId(document, surfaceId);
  if (!source || !document.windowsById[targetWindowId]) {
    return document;
  }

  if (source.windowId === targetWindowId && source.window.tabIds.length <= 1) {
    return document;
  }

  const detached = detachSurfaceFromWindow(document, surfaceId);
  const surface = detached.surface;
  if (!surface) {
    return document;
  }

  return splitWindowWithSurfaceAtEdge(detached.document, targetWindowId, placement, surface);
}

function moveActiveTabToWindow(
  document: WorkspaceDocument,
  sourceWindowId: string,
  targetWindowId: string,
): WorkspaceDocument {
  if (sourceWindowId === targetWindowId) {
    return document;
  }

  const sourceWindow = document.windowsById[sourceWindowId];
  const targetWindow = document.windowsById[targetWindowId];
  const surfaceId = sourceWindow?.activeTabId ?? null;
  if (!sourceWindow || !targetWindow || !surfaceId) {
    return document;
  }

  const nextSourceWindow = cloneWindow(sourceWindow);
  nextSourceWindow.tabIds = nextSourceWindow.tabIds.filter((tabId) => tabId !== surfaceId);
  if (nextSourceWindow.activeTabId === surfaceId) {
    const closedIndex = sourceWindow.tabIds.indexOf(surfaceId);
    nextSourceWindow.activeTabId =
      nextSourceWindow.tabIds[Math.min(closedIndex, nextSourceWindow.tabIds.length - 1)] ??
      nextSourceWindow.tabIds[0] ??
      null;
  }

  const nextTargetWindow = cloneWindow(targetWindow);
  nextTargetWindow.tabIds = [...nextTargetWindow.tabIds, surfaceId];
  nextTargetWindow.activeTabId = surfaceId;

  const nextWindowsById = {
    ...document.windowsById,
    [targetWindowId]: nextTargetWindow,
  };

  let nextRootNodeId = document.rootNodeId;
  let nextNodesById = document.nodesById;

  if (nextSourceWindow.tabIds.length > 0) {
    nextWindowsById[sourceWindowId] = nextSourceWindow;
  } else {
    delete nextWindowsById[sourceWindowId];
    const nextTree = removeWindowNodeFromTree(document, sourceWindowId);
    nextRootNodeId = nextTree.rootNodeId;
    nextNodesById = nextTree.nodesById;
  }

  return {
    ...document,
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
    windowsById: nextWindowsById,
    focusedWindowId: targetWindowId,
    mobileActiveWindowId: targetWindowId,
  };
}

function swapWindowNodePositions(
  document: WorkspaceDocument,
  sourceWindowId: string,
  targetWindowId: string,
): WorkspaceDocument {
  if (sourceWindowId === targetWindowId) {
    return document;
  }

  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  const targetNode = getWindowNodeByWindowId(document, targetWindowId);
  if (!sourceNode || !targetNode) {
    return document;
  }

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [sourceNode.nodeId]: {
        ...sourceNode.node,
        windowId: targetWindowId,
      },
      [targetNode.nodeId]: {
        ...targetNode.node,
        windowId: sourceWindowId,
      },
    },
  };
}

function findNodePath(
  document: WorkspaceDocument,
  targetNodeId: string,
  currentNodeId = document.rootNodeId,
): string[] | null {
  if (!currentNodeId) {
    return null;
  }
  if (currentNodeId === targetNodeId) {
    return [currentNodeId];
  }

  const currentNode = document.nodesById[currentNodeId];
  if (!currentNode || currentNode.kind !== "split") {
    return null;
  }

  for (const childId of currentNode.childIds) {
    const childPath = findNodePath(document, targetNodeId, childId);
    if (childPath) {
      return [currentNodeId, ...childPath];
    }
  }

  return null;
}

function findResizableSplitAdjustment(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  direction: WorkspaceDirection,
): {
  growIndex: number;
  shrinkIndex: number;
  splitNode: Extract<WorkspaceNode, { kind: "split" }>;
} | null {
  const targetWindowId = findAdjacentWindowId(document, sourceWindowId, direction);
  if (!sourceWindowId || !targetWindowId) {
    return null;
  }

  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  const targetNode = getWindowNodeByWindowId(document, targetWindowId);
  if (!sourceNode || !targetNode) {
    return null;
  }

  const sourcePath = findNodePath(document, sourceNode.nodeId);
  const targetPath = findNodePath(document, targetNode.nodeId);
  if (!sourcePath || !targetPath) {
    return null;
  }

  let sharedIndex = -1;
  const sharedLength = Math.min(sourcePath.length, targetPath.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (sourcePath[index] !== targetPath[index]) {
      break;
    }
    sharedIndex = index;
  }

  if (sharedIndex < 0) {
    return null;
  }

  const splitNodeId = sourcePath[sharedIndex];
  if (!splitNodeId) {
    return null;
  }
  const splitNode = document.nodesById[splitNodeId];
  const expectedAxis = direction === "left" || direction === "right" ? "x" : "y";
  if (!splitNode || splitNode.kind !== "split" || splitNode.axis !== expectedAxis) {
    return null;
  }

  const sourceBranchId = sourcePath[sharedIndex + 1];
  const targetBranchId = targetPath[sharedIndex + 1];
  const growIndex = splitNode.childIds.indexOf(sourceBranchId ?? "");
  const shrinkIndex = splitNode.childIds.indexOf(targetBranchId ?? "");
  if (growIndex < 0 || shrinkIndex < 0 || growIndex === shrinkIndex) {
    return null;
  }

  return {
    growIndex,
    shrinkIndex,
    splitNode,
  };
}

function resizeFocusedWindow(
  document: WorkspaceDocument,
  direction: WorkspaceDirection,
): WorkspaceDocument {
  const adjustment = findResizableSplitAdjustment(document, firstWindowId(document), direction);
  if (!adjustment) {
    return document;
  }

  const currentSizes = normalizeWorkspaceSplitSizes(
    adjustment.splitNode.sizes,
    adjustment.splitNode.childIds.length,
  );
  const shrinkSize = currentSizes[adjustment.shrinkIndex] ?? 0;
  const maxDelta = shrinkSize - WORKSPACE_MIN_RESIZE_FRACTION;
  if (maxDelta <= 0) {
    return document;
  }

  const nextSizes = [...currentSizes];
  const delta = Math.min(WORKSPACE_RESIZE_STEP, maxDelta);
  nextSizes[adjustment.growIndex] = (nextSizes[adjustment.growIndex] ?? 0) + delta;
  nextSizes[adjustment.shrinkIndex] = shrinkSize - delta;

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [adjustment.splitNode.id]: {
        ...adjustment.splitNode,
        sizes: normalizeWorkspaceSplitSizes(nextSizes, adjustment.splitNode.childIds.length),
        sizingMode: "manual",
      },
    },
  };
}

function equalizeWorkspaceSplits(document: WorkspaceDocument): WorkspaceDocument {
  let changed = false;
  const nextNodesById = Object.fromEntries(
    Object.entries(document.nodesById).map(([nodeId, node]) => {
      if (node.kind !== "split") {
        return [nodeId, node];
      }

      const nextSizes = equalSplitSizes(node.childIds.length);
      const sameSizes =
        node.sizingMode === "auto" &&
        node.sizes.length === nextSizes.length &&
        node.sizes.every((size, index) => Math.abs(size - (nextSizes[index] ?? 0)) <= 0.001);
      if (sameSizes) {
        return [nodeId, node];
      }

      changed = true;
      return [
        nodeId,
        {
          ...node,
          sizes: nextSizes,
          sizingMode: "auto",
        } satisfies WorkspaceNode,
      ];
    }),
  ) as Record<string, WorkspaceNode>;

  if (!changed) {
    return document;
  }

  return {
    ...document,
    nodesById: nextNodesById,
  };
}

function findMatchingThreadSurfaceId(
  document: WorkspaceDocument,
  input: ThreadSurfaceInput,
): string | null {
  for (const surface of Object.values(document.surfacesById)) {
    if (surface.kind === "thread" && sameThreadSurfaceInput(surface.input, input)) {
      return surface.id;
    }
  }

  return null;
}

function findMatchingTerminalSurfaceIds(
  document: WorkspaceDocument,
  input: TerminalSurfaceInput,
): string[] {
  return Object.values(document.surfacesById)
    .filter(
      (surface) => surface.kind === "terminal" && sameTerminalSurfaceInput(surface.input, input),
    )
    .map((surface) => surface.id);
}

function findTerminalSurfaceIdsForThread(
  document: WorkspaceDocument,
  threadRef: TerminalSurfaceInput["threadRef"],
): string[] {
  return Object.values(document.surfacesById)
    .filter(
      (surface) =>
        surface.kind === "terminal" &&
        surface.input.threadRef.environmentId === threadRef.environmentId &&
        surface.input.threadRef.threadId === threadRef.threadId,
    )
    .map((surface) => surface.id);
}

function preferredTerminalIdForThread(threadRef: TerminalSurfaceInput["threadRef"]): string {
  return (
    selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadKey, threadRef)
      .activeTerminalId || DEFAULT_THREAD_TERMINAL_ID
  );
}

function terminalSurfaceInputForThread(options: {
  disposition: OpenTerminalDisposition;
  threadRef: TerminalSurfaceInput["threadRef"];
}): TerminalSurfaceInput {
  const { disposition, threadRef } = options;
  return {
    scope: "thread",
    threadRef,
    terminalId:
      disposition === "focus-or-tab"
        ? preferredTerminalIdForThread(threadRef)
        : nextTerminalSessionId(),
  };
}

function normalizePersistedWorkspaceDocument(document: WorkspaceDocument): WorkspaceDocument {
  if (!document.rootNodeId || !document.nodesById[document.rootNodeId]) {
    return createEmptyWorkspaceDocument();
  }

  const normalizedTerminalCountsByThreadKey = new Map<string, number>();
  const normalizedSurfacesById = Object.fromEntries(
    Object.entries(document.surfacesById).map(([surfaceId, surface]) => {
      if (surface.kind !== "terminal") {
        return [surfaceId, surface];
      }

      const terminalThreadKey = `${surface.input.threadRef.environmentId}:${surface.input.threadRef.threadId}`;
      const normalizedTerminalCount =
        normalizedTerminalCountsByThreadKey.get(terminalThreadKey) ?? 0;
      normalizedTerminalCountsByThreadKey.set(terminalThreadKey, normalizedTerminalCount + 1);
      const fallbackTerminalId =
        normalizedTerminalCount === 0 ? DEFAULT_THREAD_TERMINAL_ID : `terminal-${surfaceId}`;

      return [
        surfaceId,
        {
          ...surface,
          input: {
            ...surface.input,
            terminalId:
              typeof surface.input.terminalId === "string" && surface.input.terminalId.length > 0
                ? surface.input.terminalId
                : fallbackTerminalId,
          },
        } satisfies WorkspaceSurfaceInstance,
      ];
    }),
  ) as Record<string, WorkspaceSurfaceInstance>;

  const normalizedNodesById = Object.fromEntries(
    Object.entries(document.nodesById).map(([nodeId, node]) => {
      if (node.kind !== "split") {
        return [nodeId, node];
      }

      return [
        nodeId,
        {
          ...node,
          sizes: normalizeWorkspaceSplitSizes(node.sizes, node.childIds.length),
          sizingMode: node.sizingMode === "manual" ? "manual" : "auto",
        } satisfies WorkspaceNode,
      ];
    }),
  ) as Record<string, WorkspaceNode>;

  return {
    ...document,
    nodesById: normalizedNodesById,
    surfacesById: normalizedSurfacesById,
  };
}

function readInitialWorkspaceDocument(): WorkspaceDocument {
  const persisted = readBrowserWorkspaceDocument<WorkspaceDocument>();
  if (!persisted || !isWorkspaceDocument(persisted)) {
    return createEmptyWorkspaceDocument();
  }
  return normalizePersistedWorkspaceDocument(persisted);
}

export interface WorkspaceStoreState {
  document: WorkspaceDocument;
  zoomedWindowId: string | null;
  openRouteTarget: (target: ThreadRouteTarget) => void;
  openThreadSurface: (input: ThreadSurfaceInput, disposition?: OpenThreadDisposition) => void;
  openThreadInNewTab: (input: ThreadSurfaceInput) => void;
  openThreadInSplit: (input: ThreadSurfaceInput, axis: WorkspaceAxis) => void;
  placeSurface: (surfaceId: string, target: WorkspacePlacementTarget) => void;
  placeThreadSurface: (input: ThreadSurfaceInput, target: WorkspacePlacementTarget) => void;
  openTerminalSurfaceForThread: (
    threadRef: TerminalSurfaceInput["threadRef"],
    disposition?: OpenTerminalDisposition,
  ) => void;
  splitWindowSurface: (windowId: string, axis: WorkspaceAxis) => void;
  setSplitNodeSizes: (nodeId: string, sizes: number[]) => void;
  closeSurface: (surfaceId: string) => void;
  closeFocusedWindow: () => void;
  focusWindow: (windowId: string) => void;
  focusWindowByStep: (step: -1 | 1) => void;
  focusAdjacentWindow: (direction: WorkspaceDirection) => void;
  focusTab: (windowId: string, surfaceId: string) => void;
  focusThreadSurface: (input: ThreadSurfaceInput) => void;
  resizeFocusedWindow: (direction: WorkspaceDirection) => void;
  equalizeSplits: () => void;
  toggleFocusedWindowZoom: () => void;
  moveActiveTabToAdjacentWindow: (direction: WorkspaceDirection) => void;
  moveFocusedWindow: (direction: WorkspaceDirection) => void;
  toggleTerminalSurfaceForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  ensureTerminalSurfaceForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  closeTerminalSurfacesForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  focusTerminalSurfaceForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  setMobileActiveWindow: (windowId: string) => void;
  resetWorkspace: () => void;
}

function setDocumentState(nextDocument: WorkspaceDocument): Partial<WorkspaceStoreState> {
  scheduleWorkspacePersistence(nextDocument);
  return { document: nextDocument };
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  document: readInitialWorkspaceDocument(),
  zoomedWindowId: null,
  openRouteTarget: (target) => {
    if (target.kind !== "server") {
      return;
    }
    get().openThreadSurface({ scope: "server", threadRef: target.threadRef }, "focus-or-tab");
  },
  openThreadSurface: (input, disposition = "focus-or-tab") => {
    const current = get().document;
    const existingSurfaceId =
      disposition === "focus-or-tab" ? findMatchingThreadSurfaceId(current, input) : null;
    if (existingSurfaceId) {
      set(setDocumentState(focusSurfaceById(current, existingSurfaceId)));
      return;
    }

    const nextSurface = createThreadSurface(input);
    const nextDocument =
      disposition === "split-right"
        ? splitWindowWithSurface(current, firstWindowId(current), "x", nextSurface)
        : disposition === "split-down"
          ? splitWindowWithSurface(current, firstWindowId(current), "y", nextSurface)
          : insertSurfaceIntoWindow(current, firstWindowId(current), nextSurface);
    set(setDocumentState(nextDocument));
  },
  openThreadInNewTab: (input) => {
    const current = get().document;
    const nextDocument = insertSurfaceIntoWindow(
      current,
      firstWindowId(current),
      createThreadSurface(input),
    );
    set(setDocumentState(nextDocument));
  },
  openThreadInSplit: (input, axis) => {
    const current = get().document;
    const nextDocument = splitWindowWithSurface(
      current,
      firstWindowId(current),
      axis,
      createThreadSurface(input),
    );
    set(setDocumentState(nextDocument));
  },
  placeSurface: (surfaceId, target) => {
    const current = get().document;
    const nextDocument =
      target.kind === "tab"
        ? (() => {
            const window = current.windowsById[target.windowId];
            const targetIndex = window?.tabIds.indexOf(target.surfaceId) ?? -1;
            if (!window || targetIndex < 0) {
              return current;
            }
            return moveSurfaceToTabIndex(current, surfaceId, target.windowId, targetIndex);
          })()
        : target.placement === "center"
          ? (() => {
              const window = current.windowsById[target.windowId];
              if (!window) {
                return current;
              }
              return moveSurfaceToTabIndex(
                current,
                surfaceId,
                target.windowId,
                window.tabIds.length,
              );
            })()
          : moveSurfaceToEdge(current, surfaceId, target.windowId, target.placement);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  placeThreadSurface: (input, target) => {
    const current = get().document;
    const existingSurfaceId = findMatchingThreadSurfaceId(current, input);
    if (existingSurfaceId) {
      get().placeSurface(existingSurfaceId, target);
      return;
    }

    const nextSurface = createThreadSurface(input);
    const nextDocument =
      target.kind === "tab"
        ? (() => {
            const window = current.windowsById[target.windowId];
            const targetIndex = window?.tabIds.indexOf(target.surfaceId) ?? -1;
            if (!window || targetIndex < 0) {
              return current;
            }
            return insertSurfaceIntoWindowAt(current, target.windowId, nextSurface, targetIndex);
          })()
        : target.placement === "center"
          ? (() => {
              const window = current.windowsById[target.windowId];
              if (!window) {
                return current;
              }
              return insertSurfaceIntoWindowAt(
                current,
                target.windowId,
                nextSurface,
                window.tabIds.length,
              );
            })()
          : splitWindowWithSurfaceAtEdge(current, target.windowId, target.placement, nextSurface);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  openTerminalSurfaceForThread: (threadRef, disposition = "focus-or-tab") => {
    const current = get().document;
    const threadSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (disposition === "focus-or-tab" && threadSurfaceIds.length > 0) {
      set(setDocumentState(focusSurfaceById(current, threadSurfaceIds[0]!)));
      return;
    }

    const input = terminalSurfaceInputForThread({ disposition, threadRef });
    const matchingSurfaceIds = findMatchingTerminalSurfaceIds(current, input);
    if (matchingSurfaceIds.length > 0) {
      set(setDocumentState(focusSurfaceById(current, matchingSurfaceIds[0]!)));
      return;
    }

    const nextSurface = createTerminalSurface(input);
    const targetWindowId = firstWindowId(current);
    const nextDocument =
      disposition === "split-right"
        ? splitWindowWithSurface(current, targetWindowId, "x", nextSurface)
        : disposition === "split-down"
          ? splitWindowWithSurface(current, targetWindowId, "y", nextSurface)
          : insertSurfaceIntoWindow(current, targetWindowId, nextSurface);
    set(setDocumentState(nextDocument));
  },
  splitWindowSurface: (windowId, axis) => {
    const current = get().document;
    const window = current.windowsById[windowId];
    const activeSurface = window?.activeTabId ? current.surfacesById[window.activeTabId] : null;
    if (!window || !activeSurface) {
      return;
    }

    const nextDocument = splitWindowWithSurface(
      current,
      windowId,
      axis,
      duplicateSurface(activeSurface),
    );
    set(setDocumentState(nextDocument));
  },
  setSplitNodeSizes: (nodeId, sizes) => {
    const current = get().document;
    const nextDocument = setWorkspaceSplitNodeSizes(current, nodeId, sizes);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  closeSurface: (surfaceId) => {
    const current = get().document;
    const nextDocument = closeSurfaceById(current, surfaceId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  closeFocusedWindow: () => {
    const current = get().document;
    const windowId = firstWindowId(current);
    if (!windowId) {
      return;
    }
    const nextDocument = closeWindowById(current, windowId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  focusWindow: (windowId) => {
    const current = get().document;
    if (!current.windowsById[windowId]) {
      return;
    }
    set(setDocumentState(setFocusedWindow(current, windowId)));
  },
  focusWindowByStep: (step) => {
    const current = get().document;
    const nextDocument = focusWindowByStep(current, step);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  focusAdjacentWindow: (direction) => {
    const current = get().document;
    const sourceWindowId = firstWindowId(current);
    const targetWindowId = findAdjacentWindowId(current, sourceWindowId, direction);
    if (!targetWindowId) {
      return;
    }
    set(setDocumentState(setFocusedWindow(current, targetWindowId)));
  },
  focusTab: (windowId, surfaceId) => {
    const current = get().document;
    const window = current.windowsById[windowId];
    if (!window || !window.tabIds.includes(surfaceId)) {
      return;
    }
    set(
      setDocumentState({
        ...current,
        windowsById: {
          ...current.windowsById,
          [windowId]: {
            ...window,
            activeTabId: surfaceId,
          },
        },
        focusedWindowId: windowId,
        mobileActiveWindowId: windowId,
      }),
    );
  },
  focusThreadSurface: (input) => {
    const current = get().document;
    const existingSurfaceId = findMatchingThreadSurfaceId(current, input);
    if (!existingSurfaceId) {
      return;
    }
    set(setDocumentState(focusSurfaceById(current, existingSurfaceId)));
  },
  resizeFocusedWindow: (direction) => {
    const current = get().document;
    const nextDocument = resizeFocusedWindow(current, direction);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  equalizeSplits: () => {
    const current = get().document;
    const nextDocument = equalizeWorkspaceSplits(current);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  toggleFocusedWindowZoom: () => {
    const current = get();
    const focusedWindowId = firstWindowId(current.document);
    if (!focusedWindowId) {
      return;
    }
    set({
      zoomedWindowId: current.zoomedWindowId === focusedWindowId ? null : focusedWindowId,
    });
  },
  moveActiveTabToAdjacentWindow: (direction) => {
    const current = get().document;
    const sourceWindowId = firstWindowId(current);
    if (!sourceWindowId) {
      return;
    }
    const targetWindowId = findAdjacentWindowId(current, sourceWindowId, direction);
    if (!targetWindowId) {
      return;
    }
    const nextDocument = moveActiveTabToWindow(current, sourceWindowId, targetWindowId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  moveFocusedWindow: (direction) => {
    const current = get().document;
    const sourceWindowId = firstWindowId(current);
    if (!sourceWindowId) {
      return;
    }
    const targetWindowId = findAdjacentWindowId(current, sourceWindowId, direction);
    if (!targetWindowId) {
      return;
    }
    const nextDocument = swapWindowNodePositions(current, sourceWindowId, targetWindowId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  toggleTerminalSurfaceForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length > 0) {
      let nextDocument = current;
      for (const surfaceId of matchingSurfaceIds) {
        nextDocument = closeSurfaceById(nextDocument, surfaceId);
      }
      set(setDocumentState(nextDocument));
      return;
    }

    const nextDocument = splitWindowWithSurface(
      current,
      firstWindowId(current),
      "y",
      createTerminalSurface({
        scope: "thread",
        threadRef,
        terminalId: preferredTerminalIdForThread(threadRef),
      }),
    );
    set(setDocumentState(nextDocument));
  },
  ensureTerminalSurfaceForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length > 0) {
      set(setDocumentState(focusSurfaceById(current, matchingSurfaceIds[0]!)));
      return;
    }

    const nextDocument = splitWindowWithSurface(
      current,
      firstWindowId(current),
      "y",
      createTerminalSurface({
        scope: "thread",
        threadRef,
        terminalId: preferredTerminalIdForThread(threadRef),
      }),
    );
    set(setDocumentState(nextDocument));
  },
  closeTerminalSurfacesForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length === 0) {
      return;
    }

    let nextDocument = current;
    for (const surfaceId of matchingSurfaceIds) {
      nextDocument = closeSurfaceById(nextDocument, surfaceId);
    }
    set(setDocumentState(nextDocument));
  },
  focusTerminalSurfaceForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length === 0) {
      return;
    }
    set(setDocumentState(focusSurfaceById(current, matchingSurfaceIds[0]!)));
  },
  setMobileActiveWindow: (windowId) => {
    const current = get().document;
    if (!current.windowsById[windowId]) {
      return;
    }
    set(
      setDocumentState({
        ...current,
        focusedWindowId: windowId,
        mobileActiveWindowId: windowId,
      }),
    );
  },
  resetWorkspace: () => {
    const nextDocument = createEmptyWorkspaceDocument();
    set({
      ...setDocumentState(nextDocument),
      zoomedWindowId: null,
    });
  },
}));

export function useWorkspaceDocument(): WorkspaceDocument {
  return useWorkspaceStore((state) => state.document);
}

export function useWorkspaceRootNodeId(): string | null {
  return useWorkspaceStore((state) => state.document.rootNodeId);
}

export function useWorkspaceWindowIds(): string[] {
  return useWorkspaceStore(
    useShallow((state) =>
      Object.keys(state.document.windowsById).filter(
        (windowId) => state.document.windowsById[windowId],
      ),
    ),
  );
}

export function useWorkspaceFocusedWindowId(): string | null {
  return useWorkspaceStore((state) => state.document.focusedWindowId);
}

export function useWorkspaceMobileActiveWindowId(): string | null {
  return useWorkspaceStore((state) => state.document.mobileActiveWindowId);
}

export function useWorkspaceZoomedWindowId(): string | null {
  return useWorkspaceStore((state) =>
    state.zoomedWindowId && state.document.windowsById[state.zoomedWindowId]
      ? state.zoomedWindowId
      : null,
  );
}

export function useWorkspaceNode(nodeId: string | null): WorkspaceNode | null {
  return useWorkspaceStore((state) => (nodeId ? (state.document.nodesById[nodeId] ?? null) : null));
}

export function useWorkspaceWindow(windowId: string | null): WorkspaceWindow | null {
  return useWorkspaceStore((state) =>
    windowId ? (state.document.windowsById[windowId] ?? null) : null,
  );
}

export function useWorkspaceSurface(surfaceId: string | null): WorkspaceSurfaceInstance | null {
  return useWorkspaceStore((state) =>
    surfaceId ? (state.document.surfacesById[surfaceId] ?? null) : null,
  );
}

export function useFocusedWorkspaceSurface(): WorkspaceSurfaceInstance | null {
  const document = useWorkspaceDocument();
  return useMemo(() => getFocusedSurface(document), [document]);
}

export function useFocusedWorkspaceRouteTarget(): ThreadRouteTarget | null {
  const document = useWorkspaceDocument();
  return useMemo(() => routeTargetForSurface(getFocusedSurface(document)), [document]);
}

export function useWorkspaceThreadTerminalOpen(
  threadRef: TerminalSurfaceInput["threadRef"] | null | undefined,
): boolean {
  return useWorkspaceStore((state) => {
    if (!threadRef) {
      return false;
    }
    return findTerminalSurfaceIdsForThread(state.document, threadRef).length > 0;
  });
}

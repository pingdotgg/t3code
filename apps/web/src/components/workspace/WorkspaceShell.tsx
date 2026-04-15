import { useParams } from "@tanstack/react-router";
import { Columns2Icon, Rows2Icon, TerminalSquareIcon, XIcon } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { SidebarInset } from "../ui/sidebar";
import ChatView from "../ChatView";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ThreadTerminalSurface } from "./ThreadTerminalSurface";
import { useWorkspaceDragStore } from "../../workspace/dragStore";
import {
  useWorkspaceFocusedWindowId,
  useWorkspaceMobileActiveWindowId,
  useWorkspaceNode,
  useWorkspaceRootNodeId,
  useWorkspaceStore,
  useWorkspaceSurface,
  useWorkspaceWindow,
  useWorkspaceWindowIds,
  useWorkspaceZoomedWindowId,
} from "../../workspace/store";
import {
  normalizeWorkspaceSplitSizes,
  type WorkspaceNode,
  type WorkspaceDropPlacement,
  type WorkspacePlacementTarget,
  type WorkspaceSurfaceInstance,
} from "../../workspace/types";

const WORKSPACE_MIN_PANE_SIZE_PX = 220;
const WORKSPACE_DROP_EDGE_THRESHOLD = 0.22;
const INTERACTIVE_PANE_TARGET_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[draggable='true']",
  "[data-pane-autofocus-prevent='true']",
].join(", ");

function isWorkspaceDropTarget(
  value: WorkspaceDropPlacement | string | null,
  target: WorkspaceDropPlacement | string,
): boolean {
  return value === target;
}

function resolveWorkspaceDropPlacementFromPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): WorkspaceDropPlacement {
  if (rect.width <= 0 || rect.height <= 0) {
    return "center";
  }

  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;
  const distanceLeft = normalizedX;
  const distanceRight = 1 - normalizedX;
  const distanceTop = normalizedY;
  const distanceBottom = 1 - normalizedY;
  const minEdgeDistance = Math.min(distanceLeft, distanceRight, distanceTop, distanceBottom);

  if (minEdgeDistance > WORKSPACE_DROP_EDGE_THRESHOLD) {
    return "center";
  }

  if (minEdgeDistance === distanceLeft) {
    return "left";
  }
  if (minEdgeDistance === distanceRight) {
    return "right";
  }
  if (minEdgeDistance === distanceTop) {
    return "top";
  }
  return "bottom";
}

function workspaceDropPreviewClass(target: WorkspaceDropPlacement | string | null): string {
  switch (target) {
    case "left":
      return "left-2 top-2 bottom-2 w-1/2";
    case "right":
      return "right-2 top-2 bottom-2 w-1/2";
    case "top":
      return "left-2 right-2 top-2 h-1/2";
    case "bottom":
      return "left-2 right-2 bottom-2 h-1/2";
    case "center":
      return "inset-2";
    default:
      return "hidden";
  }
}

function shouldSuppressPaneActivationAutoFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest("[data-pane-autofocus-allow='true']")) {
    return false;
  }

  return target.closest(INTERACTIVE_PANE_TARGET_SELECTOR) !== null;
}

function applyWorkspaceDrop(params: {
  clearDragItem: () => void;
  dragItem:
    | {
        kind: "surface";
        surfaceId: string;
      }
    | {
        kind: "thread";
        input: Parameters<ReturnType<typeof useWorkspaceStore.getState>["placeThreadSurface"]>[0];
      };
  placeSurface: ReturnType<typeof useWorkspaceStore.getState>["placeSurface"];
  placeThreadSurface: ReturnType<typeof useWorkspaceStore.getState>["placeThreadSurface"];
  target: WorkspacePlacementTarget;
}) {
  if (params.dragItem.kind === "surface") {
    params.placeSurface(params.dragItem.surfaceId, params.target);
  } else {
    params.placeThreadSurface(params.dragItem.input, params.target);
  }
  params.clearDragItem();
}

function WorkspaceEmptyState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
        <p className="text-xl text-foreground">Pick a thread to continue</p>
        <p className="mt-2 text-sm text-muted-foreground/78">
          Select an existing thread or create a new one to get started.
        </p>
      </div>
    </div>
  );
}

export function WorkspaceShell() {
  const rootNodeId = useWorkspaceRootNodeId();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {rootNodeId ? <WorkspaceLayoutRoot /> : <WorkspaceRouteFallback />}
      </div>
    </SidebarInset>
  );
}

function WorkspaceRouteFallback() {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const openThreadSurface = useWorkspaceStore((state) => state.openThreadSurface);
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  useEffect(() => {
    if (!routeTarget) {
      return;
    }

    if (routeTarget.kind === "server") {
      openThreadSurface(
        {
          scope: "server",
          threadRef: routeTarget.threadRef,
        },
        "focus-or-tab",
      );
      return;
    }

    if (!draftSession) {
      return;
    }

    openThreadSurface(
      {
        scope: "draft",
        draftId: routeTarget.draftId,
        environmentId: draftSession.environmentId,
        threadId: draftSession.threadId,
      },
      "focus-or-tab",
    );
  }, [draftSession, openThreadSurface, routeTarget]);

  if (!routeTarget) {
    return <WorkspaceEmptyState />;
  }

  if (routeTarget.kind === "server") {
    return (
      <ChatView
        environmentId={routeTarget.threadRef.environmentId}
        threadId={routeTarget.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  if (!draftSession) {
    return <WorkspaceEmptyState />;
  }

  return (
    <ChatView
      draftId={routeTarget.draftId}
      environmentId={draftSession.environmentId}
      threadId={draftSession.threadId}
      routeKind="draft"
    />
  );
}

function WorkspaceLayoutRoot() {
  const rootNodeId = useWorkspaceRootNodeId();
  const focusedWindowId = useWorkspaceFocusedWindowId();
  const mobileActiveWindowId = useWorkspaceMobileActiveWindowId();
  const windowIds = useWorkspaceWindowIds();
  const zoomedWindowId = useWorkspaceZoomedWindowId();
  const setMobileActiveWindow = useWorkspaceStore((state) => state.setMobileActiveWindow);
  const isDesktopViewport = useMediaQuery("md");
  const activeWindowId =
    zoomedWindowId ?? mobileActiveWindowId ?? focusedWindowId ?? windowIds[0] ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {windowIds.length > 1 ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          {windowIds.map((windowId, index) => {
            const isActive = (mobileActiveWindowId ?? focusedWindowId ?? windowIds[0]) === windowId;
            return (
              <button
                key={windowId}
                type="button"
                className={cn(
                  "rounded-md border px-2 py-1 text-xs",
                  isActive
                    ? "border-border bg-accent text-foreground"
                    : "border-border/60 text-muted-foreground",
                )}
                onClick={() => setMobileActiveWindow(windowId)}
              >
                Window {index + 1}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {isDesktopViewport ? (
          zoomedWindowId ? (
            <WorkspaceWindowView windowId={zoomedWindowId} />
          ) : (
            <WorkspaceNodeView nodeId={rootNodeId} />
          )
        ) : (
          <MobileWorkspaceWindow windowId={activeWindowId} />
        )}
      </div>
    </div>
  );
}

const MobileWorkspaceWindow = memo(function MobileWorkspaceWindow(props: {
  windowId: string | null;
}) {
  const window = useWorkspaceWindow(props.windowId);

  if (!props.windowId) {
    return <WorkspaceEmptyState />;
  }

  if (!window) {
    return <WorkspaceEmptyState />;
  }

  return <WorkspaceWindowView windowId={window.id} />;
});

const WorkspaceNodeView = memo(function WorkspaceNodeView(props: { nodeId: string | null }) {
  const node = useWorkspaceNode(props.nodeId);

  if (!props.nodeId) {
    return null;
  }

  if (!node) {
    return null;
  }

  if (node.kind === "window") {
    return <WorkspaceWindowView windowId={node.windowId} />;
  }

  return <WorkspaceSplitNodeView node={node} />;
});

const WorkspaceSplitNodeView = memo(function WorkspaceSplitNodeView(props: {
  node: Extract<WorkspaceNode, { kind: "split" }>;
}) {
  const setSplitNodeSizes = useWorkspaceStore((state) => state.setSplitNodeSizes);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    handle: HTMLButtonElement;
    handleIndex: number;
    pendingSizes: number[];
    pointerId: number;
    rafId: number | null;
    startCoordinate: number;
    startSizes: number[];
    totalPx: number;
  } | null>(null);
  const sizes = useMemo(
    () => normalizeWorkspaceSplitSizes(props.node.sizes, props.node.childIds.length),
    [props.node.childIds.length, props.node.sizes],
  );

  const stopResize = useCallback(
    (pointerId: number) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      if (resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId);
        setSplitNodeSizes(props.node.id, resizeState.pendingSizes);
      }
      resizeStateRef.current = null;
      if (resizeState.handle.hasPointerCapture(pointerId)) {
        resizeState.handle.releasePointerCapture(pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [props.node.id, setSplitNodeSizes],
  );

  useEffect(() => {
    return () => {
      const resizeState = resizeStateRef.current;
      if (resizeState && resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  const handleResizePointerDown = useCallback(
    (handleIndex: number, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const totalPx = props.node.axis === "x" ? rect.width : rect.height;
      if (totalPx <= 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        handle: event.currentTarget,
        handleIndex,
        pendingSizes: sizes,
        pointerId: event.pointerId,
        rafId: null,
        startCoordinate: props.node.axis === "x" ? event.clientX : event.clientY,
        startSizes: sizes,
        totalPx,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = props.node.axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [props.node.axis, sizes],
  );

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const deltaPx =
        (props.node.axis === "x" ? event.clientX : event.clientY) - resizeState.startCoordinate;
      const deltaFraction = deltaPx / resizeState.totalPx;
      const pairTotal =
        resizeState.startSizes[resizeState.handleIndex]! +
        resizeState.startSizes[resizeState.handleIndex + 1]!;
      const requestedMinFraction = WORKSPACE_MIN_PANE_SIZE_PX / resizeState.totalPx;
      const minFraction = Math.min(requestedMinFraction, Math.max(pairTotal / 2 - 0.001, 0));

      const nextBefore = Math.min(
        pairTotal - minFraction,
        Math.max(minFraction, resizeState.startSizes[resizeState.handleIndex]! + deltaFraction),
      );
      const nextAfter = pairTotal - nextBefore;
      const nextSizes = [...resizeState.startSizes];
      nextSizes[resizeState.handleIndex] = nextBefore;
      nextSizes[resizeState.handleIndex + 1] = nextAfter;
      resizeState.pendingSizes = nextSizes;
      if (resizeState.rafId !== null) {
        return;
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        const activeResizeState = resizeStateRef.current;
        if (!activeResizeState) {
          return;
        }
        activeResizeState.rafId = null;
        setSplitNodeSizes(props.node.id, activeResizeState.pendingSizes);
      });
    },
    [props.node.axis, props.node.id, setSplitNodeSizes],
  );

  const endResizeInteraction = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      stopResize(event.pointerId);
    },
    [stopResize],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden",
        props.node.axis === "x" ? "flex-row" : "flex-col",
      )}
    >
      {props.node.childIds.map((childId, index) => (
        <Fragment key={childId}>
          <div
            className="h-full min-h-0 min-w-0 overflow-hidden"
            style={{
              flexBasis: 0,
              flexGrow: sizes[index] ?? 1,
              flexShrink: 1,
            }}
          >
            <WorkspaceNodeView nodeId={childId} />
          </div>
          {index < props.node.childIds.length - 1 ? (
            <button
              type="button"
              className={cn(
                "relative z-10 shrink-0 bg-border/80 transition hover:bg-foreground/40",
                props.node.axis === "x"
                  ? "h-full w-1 cursor-col-resize touch-none"
                  : "h-1 w-full cursor-row-resize touch-none",
              )}
              aria-label={
                props.node.axis === "x" ? "Resize panes horizontally" : "Resize panes vertically"
              }
              title={props.node.axis === "x" ? "Drag to resize panes" : "Drag to resize panes"}
              onPointerCancel={endResizeInteraction}
              onPointerDown={(event) => handleResizePointerDown(index, event)}
              onPointerMove={handleResizePointerMove}
              onPointerUp={endResizeInteraction}
            >
              <span
                className={cn(
                  "pointer-events-none absolute rounded-full bg-background/90",
                  props.node.axis === "x"
                    ? "top-1/2 left-1/2 h-10 w-px -translate-x-1/2 -translate-y-1/2"
                    : "top-1/2 left-1/2 h-px w-10 -translate-x-1/2 -translate-y-1/2",
                )}
              />
            </button>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
});

const WorkspaceWindowView = memo(function WorkspaceWindowView(props: { windowId: string }) {
  const dragItem = useWorkspaceDragStore((state) => state.item);
  const clearDragItem = useWorkspaceDragStore((state) => state.clearItem);
  const focusWindow = useWorkspaceStore((state) => state.focusWindow);
  const focusTab = useWorkspaceStore((state) => state.focusTab);
  const closeSurface = useWorkspaceStore((state) => state.closeSurface);
  const placeSurface = useWorkspaceStore((state) => state.placeSurface);
  const placeThreadSurface = useWorkspaceStore((state) => state.placeThreadSurface);
  const splitWindowSurface = useWorkspaceStore((state) => state.splitWindowSurface);
  const window = useWorkspaceWindow(props.windowId);
  const activeSurface = useWorkspaceSurface(window?.activeTabId ?? null);
  const focusedWindowId = useWorkspaceFocusedWindowId();
  const [isWindowDragActive, setIsWindowDragActive] = useState(false);
  const [threadActivationFocusRequestId, setThreadActivationFocusRequestId] = useState(0);
  const [terminalActivationFocusRequestId, setTerminalActivationFocusRequestId] = useState(0);
  const [hoveredDropTarget, setHoveredDropTarget] = useState<
    WorkspaceDropPlacement | string | null
  >(null);
  const shouldAutoFocusOnActivationRef = useRef(true);
  const wasFocusedRef = useRef(focusedWindowId === props.windowId);
  const windowElementRef = useRef<HTMLElement | null>(null);
  const pendingFocusWindowFrameRef = useRef<number | null>(null);

  const resetHoveredDropTarget = useCallback(() => {
    setHoveredDropTarget(null);
  }, []);

  useEffect(() => {
    if (!dragItem) {
      setIsWindowDragActive(false);
      setHoveredDropTarget(null);
    }
  }, [dragItem]);

  useEffect(() => {
    return () => {
      if (pendingFocusWindowFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(pendingFocusWindowFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const isFocused = focusedWindowId === props.windowId;
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;

    if (!isFocused || wasFocused || !activeSurface) {
      return;
    }

    const shouldAutoFocus = shouldAutoFocusOnActivationRef.current;
    shouldAutoFocusOnActivationRef.current = true;
    if (!shouldAutoFocus) {
      return;
    }

    const activeElement = document.activeElement;
    const windowElement = windowElementRef.current;
    if (
      activeElement instanceof HTMLElement &&
      windowElement &&
      !windowElement.contains(activeElement)
    ) {
      activeElement.blur();
    }

    if (activeSurface.kind === "thread") {
      setThreadActivationFocusRequestId((current) => current + 1);
      return;
    }

    setTerminalActivationFocusRequestId((current) => current + 1);
  }, [activeSurface, focusedWindowId, props.windowId]);

  const handleWindowDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setIsWindowDragActive(true);
      setHoveredDropTarget(
        resolveWorkspaceDropPlacementFromPoint(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        ),
      );
    },
    [dragItem],
  );

  const handleWindowDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setIsWindowDragActive(false);
    setHoveredDropTarget(null);
  }, []);

  const handleDropTarget = useCallback(
    (target: WorkspacePlacementTarget) => (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyWorkspaceDrop({
        clearDragItem,
        dragItem,
        placeSurface,
        placeThreadSurface,
        target,
      });
      setIsWindowDragActive(false);
      setHoveredDropTarget(null);
    },
    [clearDragItem, dragItem, placeSurface, placeThreadSurface],
  );

  const handleDragOverTarget = useCallback(
    (hoverTarget: WorkspaceDropPlacement | string) => (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setHoveredDropTarget(hoverTarget);
    },
    [dragItem],
  );

  const handleWindowDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const targetPlacement = resolveWorkspaceDropPlacementFromPoint(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      applyWorkspaceDrop({
        clearDragItem,
        dragItem,
        placeSurface,
        placeThreadSurface,
        target: {
          kind: "window",
          windowId: props.windowId,
          placement: targetPlacement,
        },
      });
      setIsWindowDragActive(false);
      setHoveredDropTarget(null);
    },
    [clearDragItem, dragItem, placeSurface, placeThreadSurface, props.windowId],
  );

  const handleTabDragStart = useCallback(
    (surfaceId: string) => (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", surfaceId);
      useWorkspaceDragStore.getState().setItem({
        kind: "surface",
        surfaceId,
      });
      focusWindow(props.windowId);
      focusTab(props.windowId, surfaceId);
    },
    [focusTab, focusWindow, props.windowId],
  );

  const handleTabDragEnd = useCallback(() => {
    useWorkspaceDragStore.getState().clearItem();
    setHoveredDropTarget(null);
  }, []);

  if (!window) {
    return null;
  }

  return (
    <section
      ref={windowElementRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border/70 bg-background",
        focusedWindowId === props.windowId ? "ring-1 ring-border/80" : "",
      )}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) {
          shouldAutoFocusOnActivationRef.current = true;
          return;
        }
        const shouldSuppressAutoFocus = shouldSuppressPaneActivationAutoFocus(event.target);
        shouldAutoFocusOnActivationRef.current = !shouldSuppressAutoFocus;
        if (pendingFocusWindowFrameRef.current !== null) {
          globalThis.cancelAnimationFrame(pendingFocusWindowFrameRef.current);
          pendingFocusWindowFrameRef.current = null;
        }
        if (!shouldSuppressAutoFocus) {
          focusWindow(props.windowId);
          return;
        }
        pendingFocusWindowFrameRef.current = globalThis.requestAnimationFrame(() => {
          pendingFocusWindowFrameRef.current = null;
          focusWindow(props.windowId);
        });
      }}
    >
      <div className="flex min-w-0 items-center gap-1 border-b border-border/70 bg-muted/20 px-2 py-1.5">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-md transition",
            isWorkspaceDropTarget(hoveredDropTarget, "tab-strip") ? "bg-accent/60" : "",
          )}
          onDragLeave={resetHoveredDropTarget}
          onDragOver={handleDragOverTarget("tab-strip")}
          onDrop={handleDropTarget({
            kind: "window",
            windowId: props.windowId,
            placement: "center",
          })}
        >
          {window.tabIds.map((surfaceId) => {
            return (
              <WorkspaceTabView
                key={surfaceId}
                closeSurface={closeSurface}
                focusTab={focusTab}
                handleDragOverTarget={handleDragOverTarget}
                handleDropTarget={handleDropTarget}
                handleTabDragEnd={handleTabDragEnd}
                handleTabDragStart={handleTabDragStart}
                hoveredDropTarget={hoveredDropTarget}
                resetHoveredDropTarget={resetHoveredDropTarget}
                surfaceId={surfaceId}
                windowId={props.windowId}
                isActive={window.activeTabId === surfaceId}
              />
            );
          })}
        </div>
        <div className="hidden items-center gap-1 md:flex">
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={() => splitWindowSurface(props.windowId, "x")}
            aria-label="Split active tab right"
            title="Split active tab right"
          >
            <Columns2Icon className="size-3.5" />
          </button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={() => splitWindowSurface(props.windowId, "y")}
            aria-label="Split active tab down"
            title="Split active tab down"
          >
            <Rows2Icon className="size-3.5" />
          </button>
        </div>
      </div>
      <div
        className={cn(
          "h-0.5 shrink-0 transition-colors",
          focusedWindowId === props.windowId ? "bg-primary" : "bg-transparent",
        )}
      />
      <div
        className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        onDragLeave={handleWindowDragLeave}
        onDrop={handleWindowDrop}
        onDragOver={handleWindowDragOver}
      >
        {activeSurface ? (
          <WorkspaceSurfaceView
            activationFocusRequestId={
              activeSurface.kind === "thread"
                ? threadActivationFocusRequestId
                : terminalActivationFocusRequestId
            }
            surface={activeSurface}
            bindSharedComposerHandle={focusedWindowId === props.windowId}
          />
        ) : null}
        {dragItem && isWindowDragActive ? (
          <>
            <div className="pointer-events-none absolute inset-0 z-10 bg-background/10" />
            <div
              className={cn(
                "pointer-events-none absolute z-20 rounded-lg border-2 border-primary/70 bg-primary/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-all",
                workspaceDropPreviewClass(hoveredDropTarget),
              )}
            />
          </>
        ) : null}
      </div>
    </section>
  );
});

const WorkspaceTabView = memo(function WorkspaceTabView(props: {
  closeSurface: (surfaceId: string) => void;
  focusTab: (windowId: string, surfaceId: string) => void;
  handleDragOverTarget: (
    hoverTarget: WorkspaceDropPlacement | string,
  ) => (event: React.DragEvent<HTMLElement>) => void;
  handleDropTarget: (
    target: WorkspacePlacementTarget,
  ) => (event: React.DragEvent<HTMLElement>) => void;
  handleTabDragEnd: () => void;
  handleTabDragStart: (surfaceId: string) => (event: React.DragEvent<HTMLElement>) => void;
  hoveredDropTarget: WorkspaceDropPlacement | string | null;
  isActive: boolean;
  resetHoveredDropTarget: () => void;
  surfaceId: string;
  windowId: string;
}) {
  const surface = useWorkspaceSurface(props.surfaceId);

  if (!surface) {
    return null;
  }

  return (
    <div
      className={cn(
        "group flex max-w-[18rem] min-w-0 items-center gap-1 rounded-md border px-2 py-1 text-xs",
        props.isActive
          ? "border-border bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50",
        isWorkspaceDropTarget(props.hoveredDropTarget, props.surfaceId)
          ? "ring-1 ring-primary/50"
          : "",
      )}
      onDragLeave={props.resetHoveredDropTarget}
      onDragOver={props.handleDragOverTarget(props.surfaceId)}
      onDrop={props.handleDropTarget({
        kind: "tab",
        windowId: props.windowId,
        surfaceId: props.surfaceId,
      })}
    >
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left"
        data-pane-autofocus-allow="true"
        draggable
        onClick={() => props.focusTab(props.windowId, props.surfaceId)}
        onDragEnd={props.handleTabDragEnd}
        onDragStart={props.handleTabDragStart(props.surfaceId)}
      >
        <WorkspaceSurfaceTitle surface={surface} />
      </button>
      <button
        type="button"
        draggable={false}
        className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-accent hover:text-foreground"
        onClick={() => props.closeSurface(props.surfaceId)}
        aria-label="Close tab"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
});

const WorkspaceSurfaceView = memo(function WorkspaceSurfaceView(props: {
  activationFocusRequestId?: number;
  bindSharedComposerHandle?: boolean;
  surface: WorkspaceSurfaceInstance;
}) {
  if (props.surface.kind === "thread") {
    if (props.surface.input.scope === "server") {
      return (
        <ChatView
          {...(props.activationFocusRequestId === undefined
            ? {}
            : { activationFocusRequestId: props.activationFocusRequestId })}
          environmentId={props.surface.input.threadRef.environmentId}
          threadId={props.surface.input.threadRef.threadId}
          routeKind="server"
          {...(props.bindSharedComposerHandle === undefined
            ? {}
            : { bindSharedComposerHandle: props.bindSharedComposerHandle })}
        />
      );
    }

    return (
      <ChatView
        {...(props.activationFocusRequestId === undefined
          ? {}
          : { activationFocusRequestId: props.activationFocusRequestId })}
        draftId={props.surface.input.draftId}
        environmentId={props.surface.input.environmentId}
        threadId={props.surface.input.threadId}
        routeKind="draft"
        {...(props.bindSharedComposerHandle === undefined
          ? {}
          : { bindSharedComposerHandle: props.bindSharedComposerHandle })}
      />
    );
  }

  return (
    <ThreadTerminalSurface
      surfaceId={props.surface.id}
      terminalId={props.surface.input.terminalId}
      threadRef={props.surface.input.threadRef}
      {...(props.activationFocusRequestId === undefined
        ? {}
        : { activationFocusRequestId: props.activationFocusRequestId })}
    />
  );
});

function WorkspaceSurfaceTitle(props: { surface: WorkspaceSurfaceInstance }) {
  if (props.surface.kind === "terminal") {
    return <TerminalSurfaceTitle threadRef={props.surface.input.threadRef} />;
  }

  return <ThreadSurfaceTitle surface={props.surface} />;
}

function ThreadSurfaceTitle(props: {
  surface: Extract<WorkspaceSurfaceInstance, { kind: "thread" }>;
}) {
  const thread = useStore(
    useMemo(
      () =>
        createThreadSelectorByRef(
          props.surface.input.scope === "server" ? props.surface.input.threadRef : null,
        ),
      [props.surface.input],
    ),
  );
  if (props.surface.input.scope === "server") {
    return <>{thread?.title ?? props.surface.input.threadRef.threadId}</>;
  }

  return <>{thread?.title ?? props.surface.input.threadId ?? "Draft thread"}</>;
}

function TerminalSurfaceTitle(props: {
  threadRef: Extract<WorkspaceSurfaceInstance, { kind: "terminal" }>["input"]["threadRef"];
}) {
  const thread = useStore(
    useMemo(() => createThreadSelectorByRef(props.threadRef), [props.threadRef]),
  );
  const label = thread?.title ?? props.threadRef.threadId;

  return (
    <span className="inline-flex items-center gap-1">
      <TerminalSquareIcon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

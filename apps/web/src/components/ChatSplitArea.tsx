import {
  memo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ColumnsIcon, Maximize2Icon, Minimize2Icon, RowsIcon, XIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import ChatView from "./ChatView";
import { BrowserPreviewHost } from "./BrowserPreviewHost";
import { Button } from "./ui/button";
import {
  type ChatSplitDropPlacement,
  type ChatSplitFocusDirection,
  type ChatSplitNodeId,
  type ChatSplitOrientation,
  clampSplitRatio,
  countLeafNodes,
  diffRouteStatesEqual,
  isLeafNode,
} from "../chatSplitLayout";
import {
  selectActiveChatSplitLayout,
  selectChatSplitNode,
  useChatSplitLayoutStore,
} from "../chatSplitLayoutStore";
import { mergeDiffRouteSearch, type DiffRouteSearch } from "../diffRouteSearch";
import {
  type ThreadRouteTarget,
  buildThreadRouteParams,
  threadRouteTargetsEqual,
} from "../threadRoutes";
import { CHAT_SPLIT_THREAD_DRAG_MIME, decodeChatSplitThreadDragPayload } from "../chatSplitDrag";
import { cn } from "~/lib/utils";

interface ChatPaneActionsProps {
  canClose: boolean;
  isMaximized: boolean;
  onSplit: (orientation: ChatSplitOrientation) => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

function ChatPaneActions(props: ChatPaneActionsProps) {
  return (
    <div className="ml-1 flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label="Split right"
        title="Split right"
        onClick={() => props.onSplit("row")}
      >
        <ColumnsIcon className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label="Split down"
        title="Split down"
        onClick={() => props.onSplit("column")}
      >
        <RowsIcon className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={props.isMaximized ? "Restore pane" : "Maximize pane"}
        title={props.isMaximized ? "Restore pane" : "Maximize pane"}
        onClick={props.onToggleMaximize}
      >
        {props.isMaximized ? (
          <Minimize2Icon className="size-3.5" aria-hidden="true" />
        ) : (
          <Maximize2Icon className="size-3.5" aria-hidden="true" />
        )}
      </Button>
      {props.canClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Close pane"
          title="Close pane"
          onClick={props.onClose}
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

interface ChatSplitAreaProps {
  routeTarget: ThreadRouteTarget;
  routeDiffSearch?: DiffRouteSearch;
  onDiffPanelOpen?: () => void;
  reserveTitleBarControlInset?: boolean;
}

export function resolveChatPaneRenderMode(params: {
  isFocused: boolean;
  target: ThreadRouteTarget;
}): "live" | "empty" {
  if (params.target.kind !== "server") {
    return "empty";
  }
  return "live";
}

export function shouldSyncFocusedLeafToRoute(params: {
  focusedLeafTarget: ThreadRouteTarget | null;
  focusedLeafDiff: DiffRouteSearch | null;
  routeTarget: ThreadRouteTarget;
  routeDiffSearch?: DiffRouteSearch;
}): boolean {
  const { focusedLeafTarget, focusedLeafDiff, routeTarget, routeDiffSearch } = params;
  if (!focusedLeafTarget) {
    return false;
  }
  if (!threadRouteTargetsEqual(focusedLeafTarget, routeTarget)) {
    return true;
  }
  if (focusedLeafTarget.kind !== "server" || routeTarget.kind !== "server") {
    return false;
  }
  return !diffRouteStatesEqual(focusedLeafDiff, routeDiffSearch);
}

interface ChatSplitDropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function resolveChatSplitDropPlacement(params: {
  rect: ChatSplitDropRect;
  clientX: number;
  clientY: number;
}): ChatSplitDropPlacement {
  const { rect, clientX, clientY } = params;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const distances = [
    { placement: "left" as const, distance: x },
    { placement: "right" as const, distance: rect.width - x },
    { placement: "top" as const, distance: y },
    { placement: "bottom" as const, distance: rect.height - y },
  ];
  return distances.reduce((best, next) => (next.distance < best.distance ? next : best)).placement;
}

function hasChatSplitThreadDragPayload(dataTransfer: DataTransfer): boolean {
  return [...dataTransfer.types].includes(CHAT_SPLIT_THREAD_DRAG_MIME);
}

function readChatSplitThreadDragPayload(dataTransfer: DataTransfer) {
  return decodeChatSplitThreadDragPayload(dataTransfer.getData(CHAT_SPLIT_THREAD_DRAG_MIME));
}

function resolveDropOverlayClassName(placement: ChatSplitDropPlacement): string {
  switch (placement) {
    case "left":
      return "left-0 top-0 h-full w-1/2 border-r";
    case "right":
      return "right-0 top-0 h-full w-1/2 border-l";
    case "top":
      return "left-0 top-0 h-1/2 w-full border-b";
    case "bottom":
      return "bottom-0 left-0 h-1/2 w-full border-t";
  }
}

/**
 * Renders the recursive split tree for the active chat workspace.
 *
 * Routing model:
 *   - The URL always represents the currently focused leaf's target.
 *   - When the route changes, we sync that target into the layout store
 *     (focuses an existing matching leaf or replaces the focused leaf's target).
 *   - When the user focuses a different leaf inside the tree, we navigate the
 *     URL to mirror it (with replace: true to avoid history spam).
 *
 * Performance:
 *   - Each split/leaf subscribes to its own node by id via a granular zustand
 *     selector. Resizing a divider only re-renders the affected split node.
 *   - Resize drag mutates a CSS variable directly during pointermove and only
 *     commits the final ratio to the store on pointerup, so dragging is O(1)
 *     React work regardless of tree depth.
 *   - Leaves render controlled chat surfaces, so split panes do not subscribe
 *     to route search state independently.
 */
export function ChatSplitArea(props: ChatSplitAreaProps) {
  const { routeTarget, routeDiffSearch, onDiffPanelOpen, reserveTitleBarControlInset } = props;
  const navigate = useNavigate();
  const syncRouteTarget = useChatSplitLayoutStore((state) => state.syncRouteTarget);

  // Bootstrap / reconcile route → store. Idempotent in the store; safe to run on every route change.
  useLayoutEffect(() => {
    syncRouteTarget(routeTarget, routeDiffSearch);
  }, [routeTarget, routeDiffSearch, syncRouteTarget]);

  const layoutFrame = useChatSplitLayoutStore(
    useShallow((state) => {
      const layout = selectActiveChatSplitLayout(state);
      return {
        rootId: layout?.rootId ?? null,
        maximizedLeafId: layout?.maximizedLeafId ?? null,
        leafCount: layout ? countLeafNodes(layout) : 0,
      };
    }),
  );
  const focusedLeafTarget = useChatSplitLayoutStore((state) => {
    const layout = selectActiveChatSplitLayout(state);
    if (!layout) return null;
    const focused = layout.nodesById[layout.focusedLeafId];
    return focused && focused.kind === "leaf" ? focused.target : null;
  });
  const focusedLeafDiff = useChatSplitLayoutStore((state) => {
    const layout = selectActiveChatSplitLayout(state);
    if (!layout) return null;
    const focused = layout.nodesById[layout.focusedLeafId];
    return focused && focused.kind === "leaf" ? focused.diff : null;
  });

  // Store → URL: when the focused leaf's target diverges from the URL (e.g. user
  // clicked into a different leaf), navigate. Build search explicitly so
  // retainSearchParams can't carry stale diff state from the previous leaf.
  //
  // IMPORTANT: We read the focused leaf from getState() rather than from the
  // render-time selector closures. Both effects in this component run during the
  // same commit; the route→store sync effect (above) fires first and updates the
  // store synchronously. If we used the render-time `focusedLeafTarget` here, it
  // would still hold the *previous* focused leaf, causing a navigation back to the
  // old thread and creating an infinite A↔B ping-pong loop.
  useEffect(() => {
    const state = useChatSplitLayoutStore.getState();
    const layout = selectActiveChatSplitLayout(state);
    if (!layout) return;
    const focused = layout.nodesById[layout.focusedLeafId];
    if (!focused || focused.kind !== "leaf") return;
    const currentTarget = focused.target;
    const currentDiff = focused.diff;
    if (!currentTarget) return;

    if (
      !shouldSyncFocusedLeafToRoute({
        focusedLeafTarget: currentTarget,
        focusedLeafDiff: currentDiff,
        routeTarget,
        ...(routeDiffSearch !== undefined ? { routeDiffSearch } : {}),
      })
    ) {
      return;
    }
    if (currentTarget.kind === "server") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(currentTarget.threadRef),
        search: (prev) => mergeDiffRouteSearch(prev, currentDiff),
        replace: true,
      });
      return;
    }
    void navigate({
      to: "/draft/$draftId",
      params: { draftId: currentTarget.draftId },
      replace: true,
    });
  }, [focusedLeafDiff, focusedLeafTarget, navigate, routeDiffSearch, routeTarget]);

  if (!layoutFrame.rootId) {
    // Layout not bootstrapped yet — the syncRouteTarget effect on first render will create one.
    return null;
  }

  if (layoutFrame.maximizedLeafId) {
    return (
      <>
        <ChatSplitNodeRenderer
          nodeId={layoutFrame.maximizedLeafId}
          routeTarget={routeTarget}
          routeDiffSearch={routeDiffSearch}
          leafCount={layoutFrame.leafCount}
          onDiffPanelOpen={onDiffPanelOpen}
          reserveTitleBarControlInset={reserveTitleBarControlInset}
        />
        <BrowserPreviewHost />
      </>
    );
  }

  return (
    <>
      <ChatSplitNodeRenderer
        nodeId={layoutFrame.rootId}
        routeTarget={routeTarget}
        routeDiffSearch={routeDiffSearch}
        leafCount={layoutFrame.leafCount}
        onDiffPanelOpen={onDiffPanelOpen}
        reserveTitleBarControlInset={reserveTitleBarControlInset}
      />
      <BrowserPreviewHost />
    </>
  );
}

interface NodeRendererProps {
  nodeId: ChatSplitNodeId;
  routeTarget: ThreadRouteTarget;
  routeDiffSearch?: DiffRouteSearch | undefined;
  leafCount: number;
  onDiffPanelOpen?: (() => void) | undefined;
  reserveTitleBarControlInset?: boolean | undefined;
}

const ChatSplitNodeRenderer = memo(function ChatSplitNodeRenderer(props: NodeRendererProps) {
  const { nodeId } = props;
  // Subscribe to just the node identity (kind + structural id refs). Re-renders
  // only when *this* node's structural shape changes (split children, orientation).
  const nodeShape = useChatSplitLayoutStore(
    useShallow((state) => {
      const node = selectChatSplitNode(state, nodeId);
      if (!node) return null;
      if (node.kind === "leaf") {
        return { kind: "leaf" as const };
      }
      return {
        kind: "split" as const,
        first: node.first,
        second: node.second,
        orientation: node.orientation,
      };
    }),
  );

  if (!nodeShape) return null;

  if (nodeShape.kind === "leaf") {
    return (
      <ChatPaneLeaf
        leafId={nodeId}
        routeTarget={props.routeTarget}
        routeDiffSearch={props.routeDiffSearch}
        leafCount={props.leafCount}
        onDiffPanelOpen={props.onDiffPanelOpen}
        reserveTitleBarControlInset={props.reserveTitleBarControlInset}
      />
    );
  }

  return (
    <ChatSplitContainer
      splitId={nodeId}
      routeTarget={props.routeTarget}
      routeDiffSearch={props.routeDiffSearch}
      orientation={nodeShape.orientation}
      firstId={nodeShape.first}
      secondId={nodeShape.second}
      leafCount={props.leafCount}
      onDiffPanelOpen={props.onDiffPanelOpen}
      reserveTitleBarControlInset={props.reserveTitleBarControlInset}
    />
  );
});

interface SplitContainerProps {
  splitId: ChatSplitNodeId;
  routeTarget: ThreadRouteTarget;
  routeDiffSearch?: DiffRouteSearch | undefined;
  orientation: ChatSplitOrientation;
  firstId: ChatSplitNodeId;
  secondId: ChatSplitNodeId;
  leafCount: number;
  onDiffPanelOpen?: (() => void) | undefined;
  reserveTitleBarControlInset?: boolean | undefined;
}

function ChatSplitContainer(props: SplitContainerProps) {
  const { splitId, orientation, firstId, secondId } = props;
  const ratio = useChatSplitLayoutStore((state) => {
    const node = selectChatSplitNode(state, splitId);
    return node && node.kind === "split" ? node.ratio : 0.5;
  });
  const setSplitRatio = useChatSplitLayoutStore((state) => state.setSplitRatio);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; rect: DOMRect } | null>(null);
  // Live ratio used during a drag — kept out of React state so leaves don't re-render per move.
  const liveRatioRef = useRef(ratio);

  const applyRatioToDom = useCallback((nextRatio: number) => {
    const el = containerRef.current;
    if (!el) return;
    const pct = `${(nextRatio * 100).toFixed(3)}%`;
    el.style.setProperty("--chat-split-first", pct);
  }, []);

  // Sync external ratio updates (e.g. from store rehydration) into the DOM var.
  useEffect(() => {
    liveRatioRef.current = ratio;
    applyRatioToDom(ratio);
  }, [ratio, applyRatioToDom]);

  const onDividerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = container.getBoundingClientRect();
    dragStateRef.current = { pointerId: event.pointerId, rect };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  }, []);

  const computeRatioFromEvent = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): number | null => {
      const drag = dragStateRef.current;
      if (!drag) return null;
      // Recompute rect each move in case the container's size changed (e.g. sidebar toggled).
      const liveRect = containerRef.current?.getBoundingClientRect() ?? drag.rect;
      if (orientation === "row") {
        if (liveRect.width <= 0) return null;
        return clampSplitRatio((event.clientX - liveRect.left) / liveRect.width);
      }
      if (liveRect.height <= 0) return null;
      return clampSplitRatio((event.clientY - liveRect.top) / liveRect.height);
    },
    [orientation],
  );

  const onDividerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId) return;
      const next = computeRatioFromEvent(event);
      if (next === null) return;
      liveRatioRef.current = next;
      applyRatioToDom(next);
    },
    [applyRatioToDom, computeRatioFromEvent],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // releasePointerCapture throws if the pointer isn't captured anymore; safe to ignore.
      }
      document.body.style.userSelect = "";
      const final = liveRatioRef.current;
      if (final !== ratio) {
        setSplitRatio(splitId, final);
      }
    },
    [ratio, setSplitRatio, splitId],
  );

  const containerStyle = useMemo<CSSProperties>(
    () =>
      ({
        ["--chat-split-first" as string]: `${(ratio * 100).toFixed(3)}%`,
      }) as CSSProperties,
    [ratio],
  );

  const dividerClass =
    orientation === "row"
      ? "w-px shrink-0 cursor-col-resize self-stretch bg-border hover:bg-primary/60 active:bg-primary/80 [touch-action:none] relative before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']"
      : "h-px shrink-0 cursor-row-resize self-stretch bg-border hover:bg-primary/60 active:bg-primary/80 [touch-action:none] relative before:absolute before:inset-x-0 before:-top-1 before:-bottom-1 before:content-['']";

  const firstStyle: CSSProperties =
    orientation === "row"
      ? { width: "var(--chat-split-first)", minWidth: 0 }
      : { height: "var(--chat-split-first)", minHeight: 0 };
  const secondStyle: CSSProperties =
    orientation === "row" ? { flex: "1 1 0", minWidth: 0 } : { flex: "1 1 0", minHeight: 0 };

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", orientation === "row" ? "flex-row" : "flex-col")}
      style={containerStyle}
    >
      <div className="flex min-h-0 min-w-0" style={firstStyle}>
        <ChatSplitNodeRenderer
          nodeId={firstId}
          routeTarget={props.routeTarget}
          routeDiffSearch={props.routeDiffSearch}
          leafCount={props.leafCount}
          onDiffPanelOpen={props.onDiffPanelOpen}
          reserveTitleBarControlInset={props.reserveTitleBarControlInset}
        />
      </div>
      <div
        role="separator"
        aria-orientation={orientation === "row" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(ratio * 100)}
        className={dividerClass}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      />
      <div className="flex min-h-0 min-w-0" style={secondStyle}>
        <ChatSplitNodeRenderer
          nodeId={secondId}
          routeTarget={props.routeTarget}
          routeDiffSearch={props.routeDiffSearch}
          leafCount={props.leafCount}
          onDiffPanelOpen={props.onDiffPanelOpen}
          reserveTitleBarControlInset={props.reserveTitleBarControlInset}
        />
      </div>
    </div>
  );
}

interface ChatPaneLeafProps {
  leafId: ChatSplitNodeId;
  routeTarget: ThreadRouteTarget;
  routeDiffSearch?: DiffRouteSearch | undefined;
  leafCount: number;
  onDiffPanelOpen?: (() => void) | undefined;
  reserveTitleBarControlInset?: boolean | undefined;
}

function ChatPaneLeaf(props: ChatPaneLeafProps) {
  const { leafId, leafCount } = props;
  const navigate = useNavigate();
  const [dropPlacement, setDropPlacement] = useState<ChatSplitDropPlacement | null>(null);
  // Subscribe only to this leaf's identity bits + focused/maximized flags.
  const leafView = useChatSplitLayoutStore(
    useShallow((state) => {
      const layout = selectActiveChatSplitLayout(state);
      if (!layout) return null;
      const node = layout.nodesById[leafId];
      if (!node || !isLeafNode(node)) return null;
      return {
        target: node.target,
        diff: node.diff,
        isFocused: layout.focusedLeafId === leafId,
        isMaximized: layout.maximizedLeafId === leafId,
      };
    }),
  );
  const focusLeafAction = useChatSplitLayoutStore((state) => state.focusLeaf);
  const splitFocusedLeaf = useChatSplitLayoutStore((state) => state.splitFocusedLeaf);
  const closeFocusedLeaf = useChatSplitLayoutStore((state) => state.closeFocusedLeaf);
  const toggleFocusedLeafMaximized = useChatSplitLayoutStore(
    (state) => state.toggleFocusedLeafMaximized,
  );
  const replaceLeafTarget = useChatSplitLayoutStore((state) => state.replaceLeafTarget);
  const dropTargetIntoLeaf = useChatSplitLayoutStore((state) => state.dropTargetIntoLeaf);

  const handlePointerDownCapture = useCallback(() => {
    if (leafView && !leafView.isFocused) {
      focusLeafAction(leafId);
    }
  }, [focusLeafAction, leafId, leafView]);

  const handleSplit = useCallback(
    (orientation: ChatSplitOrientation) => {
      if (!leafView?.isFocused) {
        focusLeafAction(leafId);
      }
      splitFocusedLeaf(orientation);
    },
    [focusLeafAction, leafId, leafView?.isFocused, splitFocusedLeaf],
  );

  const handleClose = useCallback(() => {
    if (!leafView?.isFocused) {
      focusLeafAction(leafId);
    }
    closeFocusedLeaf();
  }, [closeFocusedLeaf, focusLeafAction, leafId, leafView?.isFocused]);

  const handleToggleMaximize = useCallback(() => {
    if (!leafView?.isFocused) {
      focusLeafAction(leafId);
    }
    toggleFocusedLeafMaximized();
  }, [focusLeafAction, leafId, leafView?.isFocused, toggleFocusedLeafMaximized]);

  const handleDiffSearchChange = useCallback(
    (next: DiffRouteSearch) => {
      // Replace this leaf's diff in the store; the route will be brought into
      // sync by the focused-leaf navigation effect when this leaf is focused.
      const target = leafView?.target;
      if (!target) return;
      replaceLeafTarget(leafId, target, next);
    },
    [leafId, leafView?.target, replaceLeafTarget],
  );

  const updateDropPlacement = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasChatSplitThreadDragPayload(event.dataTransfer)) {
        setDropPlacement(null);
        return null;
      }

      if (!leafView?.target) {
        setDropPlacement("right");
        return "right";
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const placement = resolveChatSplitDropPlacement({
        rect,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      setDropPlacement(placement);
      return placement;
    },
    [leafView?.target],
  );

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const placement = updateDropPlacement(event);
      if (!placement) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [updateDropPlacement],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const placement = updateDropPlacement(event);
      if (!placement) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [updateDropPlacement],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropPlacement(null);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const placement = updateDropPlacement(event);
      const threadRef = readChatSplitThreadDragPayload(event.dataTransfer);
      setDropPlacement(null);
      if (!placement || !threadRef) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const focusedTarget = dropTargetIntoLeaf(
        leafId,
        {
          kind: "server",
          threadRef,
        },
        placement,
      );
      if (!focusedTarget || focusedTarget.kind !== "server") {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(focusedTarget.threadRef),
      });
    },
    [dropTargetIntoLeaf, leafId, navigate, updateDropPlacement],
  );

  const paneActions = useMemo<ReactNode>(() => {
    if (!leafView) return null;
    return (
      <ChatPaneActions
        canClose={leafCount > 1}
        isMaximized={leafView.isMaximized}
        onSplit={handleSplit}
        onToggleMaximize={handleToggleMaximize}
        onClose={handleClose}
      />
    );
  }, [leafCount, leafView, handleClose, handleSplit, handleToggleMaximize]);

  if (!leafView) return null;
  const { target, diff, isFocused } = leafView;
  const displayTarget =
    target && isFocused && !threadRouteTargetsEqual(target, props.routeTarget)
      ? props.routeTarget
      : target;
  const displayDiff = displayTarget === props.routeTarget ? (props.routeDiffSearch ?? {}) : diff;

  // The focused-leaf ring is purely cosmetic; we only show it when there's more than one pane,
  // because a single pane with a ring just adds visual chrome.
  const focusRing =
    leafCount > 1 && isFocused
      ? "ring-1 ring-inset ring-primary/25"
      : "ring-1 ring-inset ring-transparent";

  if (!displayTarget) {
    return (
      <div
        onPointerDownCapture={handlePointerDownCapture}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-background", focusRing)}
      >
        <div className="drag-region flex h-13 shrink-0 items-center justify-end border-b border-border/40 px-2">
          <div className="no-drag">{paneActions}</div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <p className="max-w-64 text-sm text-muted-foreground">
            Click or drag another chat you would like to split with
          </p>
        </div>
        {dropPlacement ? <ChatSplitBlankDropOverlay /> : null}
      </div>
    );
  }

  // Drafts are rendered by their own dedicated single-pane route; if a persisted layout ever
  // surfaces a draft leaf here, fall back to an empty pane rather than mounting ChatView with
  // synthetic ids. Splitting is therefore a server-thread feature for v1.
  if (displayTarget.kind !== "server") {
    return (
      <div
        onPointerDownCapture={handlePointerDownCapture}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-background", focusRing)}
      >
        {dropPlacement ? <ChatSplitDropOverlay placement={dropPlacement} /> : null}
      </div>
    );
  }

  const serverTarget = displayTarget;

  return (
    <div
      onPointerDownCapture={handlePointerDownCapture}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-background", focusRing)}
    >
      <ChatView
        environmentId={serverTarget.threadRef.environmentId}
        threadId={serverTarget.threadRef.threadId}
        isPaneFocused={isFocused}
        routeKind="server"
        {...(props.onDiffPanelOpen ? { onDiffPanelOpen: props.onDiffPanelOpen } : {})}
        {...(props.reserveTitleBarControlInset !== undefined
          ? { reserveTitleBarControlInset: props.reserveTitleBarControlInset }
          : {})}
        diffSearch={displayDiff}
        onDiffSearchChange={handleDiffSearchChange}
        paneActions={paneActions}
      />
      {dropPlacement ? <ChatSplitDropOverlay placement={dropPlacement} /> : null}
    </div>
  );
}

function ChatSplitDropOverlay(props: { placement: ChatSplitDropPlacement }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 bg-primary/5 ring-1 ring-inset ring-primary/45">
      <div
        data-testid={`chat-split-drop-overlay-${props.placement}`}
        className={cn(
          "absolute border-primary/70 bg-primary/15 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]",
          resolveDropOverlayClassName(props.placement),
        )}
      />
    </div>
  );
}

function ChatSplitBlankDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 bg-primary/10 ring-1 ring-inset ring-primary/60">
      <div
        data-testid="chat-split-drop-overlay-fill"
        className="absolute inset-0 border border-primary/70 bg-primary/10 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
    </div>
  );
}

// Exported for tests / external focus shortcuts (unused for now but keeps the public surface tidy).
export type { ChatSplitFocusDirection };

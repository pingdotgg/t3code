import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";

import {
  calculatePaneTreeLayout,
  clampPaneSplitRatio,
  getVisiblePaneTreeRoot,
  resizePaneSplit,
  type PaneDropZone,
  type PaneId,
  type PaneNode,
  type PaneSplitId,
  type PaneSplitNode,
  type PaneTabDragData,
  type PaneTree,
  type PaneBounds,
} from "~/splitPaneTree";
import { cn } from "~/lib/utils";

import {
  calculatePaneSplitRatio,
  canDropPaneTab,
  resolvePaneDropZone,
  resolveKeyboardResizeDelta,
} from "./SplitPaneGrid.logic";

export interface PaneFocusPulse {
  readonly paneId: PaneId;
  readonly sequence: number;
}

interface SplitPaneGridProps {
  tree: PaneTree;
  renderPane: (group: PaneNode) => ReactNode;
  onFocusPane: (paneId: PaneId) => void;
  onResizeSplit: (splitId: PaneSplitId, ratio: number) => void;
  draggedTab?: PaneTabDragData | null;
  canCopyDraggedTabFromSolePane?: boolean;
  focusPulse?: PaneFocusPulse | null;
  onDropTab?: (input: {
    readonly draggedTab: PaneTabDragData;
    readonly targetPaneId: PaneId;
    readonly zone: PaneDropZone;
  }) => void;
  className?: string;
}

interface PaneDropPreview {
  readonly paneId: PaneId;
  readonly zone: PaneDropZone;
}

interface StoredPaneDropPreview extends PaneDropPreview {
  readonly draggedTab: PaneTabDragData;
}

export function SplitPaneGrid(props: SplitPaneGridProps) {
  const [resizePreview, setResizePreview] = useState<{
    readonly splitId: PaneSplitId;
    readonly ratio: number;
  } | null>(null);
  const previewTree = resizePreview
    ? resizePaneSplit(props.tree, resizePreview.splitId, resizePreview.ratio)
    : props.tree;
  const visibleRoot = getVisiblePaneTreeRoot(previewTree);
  const layout = calculatePaneTreeLayout(visibleRoot);
  const containerRef = useRef<HTMLDivElement>(null);
  const [storedDropPreview, setStoredDropPreview] = useState<StoredPaneDropPreview | null>(null);
  const dropPreview =
    props.draggedTab &&
    storedDropPreview?.draggedTab.sourcePaneId === props.draggedTab.sourcePaneId &&
    storedDropPreview.draggedTab.sourceTabId === props.draggedTab.sourceTabId
      ? storedDropPreview
      : null;
  return (
    <div
      ref={containerRef}
      className={cn("relative min-h-0 min-w-0 flex-1 overflow-hidden", props.className)}
      data-editor-focus-view={props.tree.maximizedPaneId ? "true" : "false"}
    >
      {layout.groups.map(({ group, bounds }) => (
        <SplitPane
          key={group.id}
          bounds={bounds}
          group={group}
          focusedPaneId={props.tree.focusedPaneId}
          renderPane={props.renderPane}
          onFocusPane={props.onFocusPane}
          tree={props.tree}
          draggedTab={props.draggedTab ?? null}
          canCopyDraggedTabFromSolePane={props.canCopyDraggedTabFromSolePane ?? false}
          focusPulse={props.focusPulse ?? null}
          onDropTab={props.onDropTab}
          dropPreview={dropPreview}
          setDropPreview={(preview) =>
            setStoredDropPreview(
              preview && props.draggedTab ? { ...preview, draggedTab: props.draggedTab } : null,
            )
          }
        />
      ))}
      {layout.splits.map(({ split, bounds }) => (
        <PaneSplitHandle
          key={split.id}
          bounds={bounds}
          containerRef={containerRef}
          split={split}
          onResizePreview={(ratio) => setResizePreview({ splitId: split.id, ratio })}
          onResizeCommit={(ratio) => {
            props.onResizeSplit(split.id, ratio);
            setResizePreview(null);
          }}
          onResizeCancel={() => setResizePreview(null)}
        />
      ))}
    </div>
  );
}

interface SplitPaneProps {
  bounds: PaneBounds;
  group: PaneNode;
  focusedPaneId: PaneId;
  renderPane: (group: PaneNode) => ReactNode;
  onFocusPane: (paneId: PaneId) => void;
  tree: PaneTree;
  draggedTab: PaneTabDragData | null;
  canCopyDraggedTabFromSolePane: boolean;
  focusPulse: PaneFocusPulse | null;
  onDropTab: SplitPaneGridProps["onDropTab"];
  dropPreview: PaneDropPreview | null;
  setDropPreview: (preview: PaneDropPreview | null) => void;
}

function SplitPane(props: SplitPaneProps) {
  const { group } = props;
  return (
    // Keep surface-local overlays below the tree's sibling split handles.
    <section
      className={cn(
        "absolute isolate flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        props.tree.root._tag === "Split" &&
          group.id === props.focusedPaneId &&
          "ring-1 ring-inset ring-primary/25",
      )}
      style={paneBoundsStyle(props.bounds)}
      data-editor-group={group.id}
      data-editor-group-focused={group.id === props.focusedPaneId ? "true" : "false"}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-editor-tab]")) return;
        props.onFocusPane(group.id);
      }}
    >
      {props.renderPane(group)}
      {props.focusPulse?.paneId === group.id ? (
        <span
          key={props.focusPulse.sequence}
          aria-hidden
          className="t3-pane-focus-ring pointer-events-none absolute inset-0 z-[60] ring-2 ring-inset ring-primary/80"
          data-editor-focus-pulse=""
        />
      ) : null}
      {props.onDropTab ? (
        <PaneDropTarget
          tree={props.tree}
          group={group}
          draggedTab={props.draggedTab}
          canCopyFromSolePane={props.canCopyDraggedTabFromSolePane}
          preview={props.dropPreview?.paneId === group.id ? props.dropPreview : null}
          onPreviewChange={props.setDropPreview}
          onDrop={props.onDropTab}
        />
      ) : null}
    </section>
  );
}

function paneBoundsStyle(bounds: PaneBounds): CSSProperties {
  return {
    top: `${bounds.top * 100}%`,
    left: `${bounds.left * 100}%`,
    width: `${(bounds.right - bounds.left) * 100}%`,
    height: `${(bounds.bottom - bounds.top) * 100}%`,
  };
}

function PaneDropTarget(props: {
  readonly tree: PaneTree;
  readonly group: PaneNode;
  readonly draggedTab: PaneTabDragData | null;
  readonly canCopyFromSolePane: boolean;
  readonly preview: PaneDropPreview | null;
  readonly onPreviewChange: (preview: PaneDropPreview | null) => void;
  readonly onDrop: NonNullable<SplitPaneGridProps["onDropTab"]>;
}) {
  const resolveDropZone = (event: DragEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return resolvePaneDropZone({
      clientX: event.clientX,
      clientY: event.clientY,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    });
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!props.draggedTab) return;
    const zone = resolveDropZone(event);
    if (
      !zone ||
      !canDropPaneTab({
        tree: props.tree,
        draggedTab: props.draggedTab,
        targetPaneId: props.group.id,
        zone,
        canCopyFromSolePane: props.canCopyFromSolePane,
      })
    ) {
      event.dataTransfer.dropEffect = "none";
      props.onPreviewChange(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (props.preview?.zone !== zone) {
      props.onPreviewChange({ paneId: props.group.id, zone });
    }
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    props.onPreviewChange(null);
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!props.draggedTab) return;
    const zone = resolveDropZone(event);
    if (
      !zone ||
      !canDropPaneTab({
        tree: props.tree,
        draggedTab: props.draggedTab,
        targetPaneId: props.group.id,
        zone,
        canCopyFromSolePane: props.canCopyFromSolePane,
      })
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    props.onPreviewChange(null);
    props.onDrop({ draggedTab: props.draggedTab, targetPaneId: props.group.id, zone });
  };

  return (
    <div
      className={cn(
        "absolute inset-0 z-50",
        props.draggedTab ? "pointer-events-auto" : "pointer-events-none",
      )}
      data-editor-group-drop-target={props.group.id}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {props.preview ? <PaneDropOverlay zone={props.preview.zone} /> : null}
    </div>
  );
}

function PaneDropOverlay({ zone }: { readonly zone: PaneDropZone }) {
  const label =
    zone === "center"
      ? "Swap panes"
      : zone === "up"
        ? "Split above"
        : zone === "down"
          ? "Split below"
          : zone === "left"
            ? "Split left"
            : "Split right";
  return (
    <div
      className={cn(
        "pointer-events-none absolute flex items-center justify-center rounded-lg bg-primary/20 ring-2 ring-inset ring-primary/80 transition-[inset,width,height,opacity] duration-100 ease-out",
        zone === "center" && "inset-2",
        zone === "left" && "inset-y-2 left-2 w-[calc(50%-0.5rem)]",
        zone === "right" && "inset-y-2 right-2 w-[calc(50%-0.5rem)]",
        zone === "up" && "inset-x-2 top-2 h-[calc(50%-0.5rem)]",
        zone === "down" && "inset-x-2 bottom-2 h-[calc(50%-0.5rem)]",
      )}
      data-editor-drop-zone={zone}
    >
      <span className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-sm">
        {label}
      </span>
    </div>
  );
}

interface DragState {
  readonly pointerId: number;
  readonly start: number;
  readonly size: number;
  pendingRatio: number;
  frameId: number | null;
  readonly target: HTMLDivElement;
}

function PaneSplitHandle(props: {
  bounds: PaneBounds;
  containerRef: RefObject<HTMLDivElement | null>;
  split: PaneSplitNode;
  onResizePreview: (ratio: number) => void;
  onResizeCommit: (ratio: number) => void;
  onResizeCancel: () => void;
}) {
  const { split, onResizePreview, onResizeCommit, onResizeCancel } = props;
  const dragStateRef = useRef<DragState | null>(null);
  const horizontal = split.orientation === "horizontal";

  const releasePointer = useCallback((pointerId: number) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    if (dragState.frameId !== null) cancelAnimationFrame(dragState.frameId);
    try {
      if (dragState.target.hasPointerCapture(pointerId)) {
        dragState.target.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture may already have ended when the window loses focus.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    dragStateRef.current = null;
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const container = props.containerRef.current;
      if (!container) return;
      const workspaceBounds = container.getBoundingClientRect();
      const start = horizontal
        ? workspaceBounds.left + workspaceBounds.width * props.bounds.left
        : workspaceBounds.top + workspaceBounds.height * props.bounds.top;
      const size = horizontal
        ? workspaceBounds.width * (props.bounds.right - props.bounds.left)
        : workspaceBounds.height * (props.bounds.bottom - props.bounds.top);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        start,
        size,
        pendingRatio: split.ratio,
        frameId: null,
        target: event.currentTarget,
      };
      document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      event.preventDefault();
      event.stopPropagation();
    },
    [horizontal, props.bounds, props.containerRef, split.ratio],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const position = horizontal ? event.clientX : event.clientY;
      const ratio = calculatePaneSplitRatio(position, dragState.start, dragState.size);
      if (ratio === null) return;
      dragState.pendingRatio = ratio;
      if (dragState.frameId !== null) return;
      dragState.frameId = requestAnimationFrame(() => {
        const activeDrag = dragStateRef.current;
        if (!activeDrag) return;
        activeDrag.frameId = null;
        onResizePreview(activeDrag.pendingRatio);
      });
    },
    [horizontal, onResizePreview],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const finalRatio = dragState.pendingRatio;
      releasePointer(event.pointerId);
      onResizeCommit(finalRatio);
    },
    [onResizeCommit, releasePointer],
  );

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      releasePointer(event.pointerId);
      onResizeCancel();
    },
    [onResizeCancel, releasePointer],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const delta = resolveKeyboardResizeDelta(event.key, split.orientation);
      if (delta === null) return;
      const ratio = clampPaneSplitRatio(split.ratio + delta);
      if (ratio !== null) onResizeCommit(ratio);
      event.preventDefault();
    },
    [onResizeCommit, split],
  );
  const splitPosition =
    split.orientation === "horizontal"
      ? props.bounds.left + (props.bounds.right - props.bounds.left) * split.ratio
      : props.bounds.top + (props.bounds.bottom - props.bounds.top) * split.ratio;
  const style: CSSProperties = horizontal
    ? {
        top: `${props.bounds.top * 100}%`,
        left: `${splitPosition * 100}%`,
        height: `${(props.bounds.bottom - props.bounds.top) * 100}%`,
      }
    : {
        top: `${splitPosition * 100}%`,
        left: `${props.bounds.left * 100}%`,
        width: `${(props.bounds.right - props.bounds.left) * 100}%`,
      };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={horizontal ? "Resize editor columns" : "Resize editor rows"}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={Math.round(split.ratio * 100)}
      data-editor-split={split.id}
      data-editor-split-orientation={split.orientation}
      className={cn(
        "group/split absolute z-10 touch-none bg-border outline-none",
        "focus-visible:bg-primary/70",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
      style={style}
      onDoubleClick={() => onResizeCommit(0.5)}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <span
        aria-hidden
        className={cn(
          "absolute transition-colors group-hover/split:bg-primary/60 group-focus-visible/split:bg-primary/70",
          horizontal ? "inset-y-0 -left-1 w-[9px]" : "inset-x-0 -top-1 h-[9px]",
        )}
      />
    </div>
  );
}

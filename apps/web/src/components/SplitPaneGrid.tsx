import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  calculatePaneTreeLayout,
  clampPaneSplitRatio,
  findPane,
  getVisiblePaneTreeRoot,
  resizePaneSplit,
  type PaneDropZone,
  type PaneId,
  type PaneNode,
  type PaneSplitId,
  type PaneSplitNode,
  type PaneTabDragData,
  type PaneTabId,
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

export type PaneTabBarDropPreview =
  | {
      readonly targetTabId: PaneTabId;
      readonly position: "before" | "after";
    }
  | {
      readonly targetTabId: null;
      readonly position: "end";
    };

type PaneDragDropPreview =
  | ({ readonly _tag: "Pane" } & PaneDropPreview)
  | ({ readonly _tag: "Tab"; readonly paneId: PaneId } & PaneTabBarDropPreview);

interface SplitPaneGridProps {
  tree: PaneTree;
  renderPane: (group: PaneNode, tabDropPreview: PaneTabBarDropPreview | null) => ReactNode;
  onFocusPane: (paneId: PaneId) => void;
  onResizeSplit: (splitId: PaneSplitId, ratio: number) => void;
  canCopyDraggedTabFromSolePane?: (draggedTab: PaneTabDragData) => boolean;
  focusPulse?: PaneFocusPulse | null;
  onDropTab?: (input: {
    readonly draggedTab: PaneTabDragData;
    readonly targetPaneId: PaneId;
    readonly zone: PaneDropZone;
  }) => void;
  onDropTabAtIndex?: (input: {
    readonly draggedTab: PaneTabDragData;
    readonly targetPaneId: PaneId;
    readonly targetIndex: number;
  }) => void;
  className?: string;
}

interface PaneDropPreview {
  readonly paneId: PaneId;
  readonly zone: PaneDropZone;
}

function paneWithDomId(
  paneById: ReadonlyMap<string, PaneNode>,
  paneId: string | null,
): PaneNode | null {
  if (paneId === null) return null;
  return paneById.get(paneId) ?? null;
}

function resolvePaneTabDragData(
  event: DragStartEvent,
  paneById: ReadonlyMap<string, PaneNode>,
): PaneTabDragData | null {
  const data = event.active.data.current;
  const sourcePane = paneWithDomId(
    paneById,
    typeof data?.sourcePaneId === "string" ? data.sourcePaneId : null,
  );
  if (!sourcePane) return null;
  const sourceTabId = sourcePane.tabIds.find((tabId) => tabId === data?.sourceTabId);
  return sourceTabId ? { sourcePaneId: sourcePane.id, sourceTabId } : null;
}

function dragPointerCoordinates(
  event: Pick<DragMoveEvent, "activatorEvent" | "delta">,
): { readonly x: number; readonly y: number } | null {
  if (!(event.activatorEvent instanceof MouseEvent)) return null;
  return {
    x: event.activatorEvent.clientX + event.delta.x,
    y: event.activatorEvent.clientY + event.delta.y,
  };
}

function firstClosestElement(elements: readonly Element[], selector: string): HTMLElement | null {
  for (const element of elements) {
    const match = element.closest<HTMLElement>(selector);
    if (match) return match;
  }
  return null;
}

function resolveDragDropPreview(input: {
  readonly tree: PaneTree;
  readonly paneById: ReadonlyMap<string, PaneNode>;
  readonly draggedTab: PaneTabDragData;
  readonly clientX: number;
  readonly clientY: number;
  readonly canCopyFromSolePane: boolean;
}): PaneDragDropPreview | null {
  const elements = document.elementsFromPoint(input.clientX, input.clientY);
  const tabElement = firstClosestElement(elements, "[data-editor-pane-tab-id]");
  if (tabElement) {
    const targetPane = paneWithDomId(input.paneById, tabElement.dataset.editorPaneId ?? null);
    const targetTabId = targetPane?.tabIds.find(
      (tabId) => tabId === tabElement.dataset.editorPaneTabId,
    );
    if (
      targetPane &&
      targetTabId &&
      (targetPane.id === input.draggedTab.sourcePaneId ||
        canDropPaneTab({
          tree: input.tree,
          draggedTab: input.draggedTab,
          targetPaneId: targetPane.id,
          zone: "center",
          canCopyFromSolePane: input.canCopyFromSolePane,
        }))
    ) {
      const bounds = tabElement.getBoundingClientRect();
      return {
        _tag: "Tab",
        paneId: targetPane.id,
        targetTabId,
        position: input.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
      };
    }
  }

  const tabListElement = firstClosestElement(elements, "[data-editor-pane-tab-list]");
  if (tabListElement) {
    const targetPane = paneWithDomId(
      input.paneById,
      tabListElement.dataset.editorPaneTabList ?? null,
    );
    if (
      targetPane &&
      (targetPane.id === input.draggedTab.sourcePaneId ||
        canDropPaneTab({
          tree: input.tree,
          draggedTab: input.draggedTab,
          targetPaneId: targetPane.id,
          zone: "center",
          canCopyFromSolePane: input.canCopyFromSolePane,
        }))
    ) {
      return { _tag: "Tab", paneId: targetPane.id, targetTabId: null, position: "end" };
    }
  }

  const paneElement = firstClosestElement(elements, "[data-editor-group]");
  const targetPane = paneWithDomId(input.paneById, paneElement?.dataset.editorGroup ?? null);
  if (!paneElement || !targetPane) return null;
  const bounds = paneElement.getBoundingClientRect();
  const zone = resolvePaneDropZone({
    clientX: input.clientX,
    clientY: input.clientY,
    bounds: {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    },
  });
  if (
    !zone ||
    !canDropPaneTab({
      tree: input.tree,
      draggedTab: input.draggedTab,
      targetPaneId: targetPane.id,
      zone,
      canCopyFromSolePane: input.canCopyFromSolePane,
    })
  ) {
    return null;
  }
  return { _tag: "Pane", paneId: targetPane.id, zone };
}

function sameDragDropPreview(
  left: PaneDragDropPreview | null,
  right: PaneDragDropPreview | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left._tag !== right._tag || left.paneId !== right.paneId) return false;
  if (left._tag === "Pane" && right._tag === "Pane") return left.zone === right.zone;
  if (left._tag === "Tab" && right._tag === "Tab") {
    return left.targetTabId === right.targetTabId && left.position === right.position;
  }
  return false;
}

export function SplitPaneGrid(props: SplitPaneGridProps) {
  const visibleRoot = getVisiblePaneTreeRoot(props.tree);
  const layout = calculatePaneTreeLayout(visibleRoot);
  const paneById = useMemo(
    () =>
      new Map(
        calculatePaneTreeLayout(props.tree.root).groups.map(({ group }) => [group.id, group]),
      ),
    [props.tree.root],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const resizePreviewRef = useRef<{ readonly splitId: PaneSplitId; readonly ratio: number } | null>(
    null,
  );
  const latestPointerCoordinatesRef = useRef<{ readonly x: number; readonly y: number } | null>(
    null,
  );
  const [draggedTab, setDraggedTab] = useState<PaneTabDragData | null>(null);
  const [draggedTabLabel, setDraggedTabLabel] = useState<string | null>(null);
  const draggedTabRef = useRef<PaneTabDragData | null>(null);
  const [dropPreview, setDropPreviewState] = useState<PaneDragDropPreview | null>(null);
  const dropPreviewRef = useRef<PaneDragDropPreview | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const previewSplitResize = useCallback(
    (splitId: PaneSplitId, ratio: number) => {
      resizePreviewRef.current = { splitId, ratio };
      const container = containerRef.current;
      if (!container) return;
      applyPaneTreeLayout(container, resizePaneSplit(props.tree, splitId, ratio));
    },
    [props.tree],
  );
  const resetSplitResize = useCallback(() => {
    resizePreviewRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    applyPaneTreeLayout(container, props.tree);
  }, [props.tree]);
  useLayoutEffect(() => {
    const preview = resizePreviewRef.current;
    const container = containerRef.current;
    if (!preview || !container) return;
    applyPaneTreeLayout(container, resizePaneSplit(props.tree, preview.splitId, preview.ratio));
  });
  const setDropPreview = (preview: PaneDragDropPreview | null) => {
    if (sameDragDropPreview(dropPreviewRef.current, preview)) return;
    dropPreviewRef.current = preview;
    setDropPreviewState(preview);
  };
  const resetDrag = () => {
    draggedTabRef.current = null;
    latestPointerCoordinatesRef.current = null;
    setDraggedTab(null);
    setDraggedTabLabel(null);
    setDropPreview(null);
  };
  const handleDragStart = (event: DragStartEvent) => {
    const dragData = resolvePaneTabDragData(event, paneById);
    if (!dragData) return;
    draggedTabRef.current = dragData;
    setDraggedTab(dragData);
    setDraggedTabLabel(
      typeof event.active.data.current?.label === "string"
        ? event.active.data.current.label
        : "Tab",
    );
  };
  const handleDragMove = (event: DragMoveEvent) => {
    const dragData = draggedTabRef.current;
    const coordinates = dragPointerCoordinates(event);
    if (!dragData || !coordinates) return;
    setDropPreview(
      resolveDragDropPreview({
        tree: props.tree,
        paneById,
        draggedTab: dragData,
        clientX: coordinates.x,
        clientY: coordinates.y,
        canCopyFromSolePane: props.canCopyDraggedTabFromSolePane?.(dragData) ?? false,
      }),
    );
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const dragData = draggedTabRef.current;
    const eventCoordinates = dragPointerCoordinates(event);
    const coordinates =
      event.delta.x === 0 && event.delta.y === 0
        ? (latestPointerCoordinatesRef.current ?? eventCoordinates)
        : eventCoordinates;
    const preview =
      dragData && coordinates
        ? resolveDragDropPreview({
            tree: props.tree,
            paneById,
            draggedTab: dragData,
            clientX: coordinates.x,
            clientY: coordinates.y,
            canCopyFromSolePane: props.canCopyDraggedTabFromSolePane?.(dragData) ?? false,
          })
        : dropPreviewRef.current;
    if (dragData && preview?._tag === "Pane") {
      props.onDropTab?.({
        draggedTab: dragData,
        targetPaneId: preview.paneId,
        zone: preview.zone,
      });
    } else if (dragData && preview?._tag === "Tab") {
      const targetPane = findPane(props.tree.root, preview.paneId);
      const targetTabIndex =
        preview.targetTabId === null ? -1 : (targetPane?.tabIds.indexOf(preview.targetTabId) ?? -1);
      const targetIndex =
        preview.position === "end"
          ? (targetPane?.tabIds.length ?? -1)
          : targetTabIndex + (preview.position === "after" ? 1 : 0);
      if (targetPane && targetIndex >= 0) {
        props.onDropTabAtIndex?.({
          draggedTab: dragData,
          targetPaneId: targetPane.id,
          targetIndex,
        });
      }
    }
    resetDrag();
  };
  return (
    <DndContext
      sensors={sensors}
      onDragCancel={resetDrag}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragStart={handleDragStart}
    >
      <div
        ref={containerRef}
        className={cn(
          "relative min-h-0 min-w-0 flex-1 overflow-hidden",
          draggedTab && "cursor-grabbing [&_*]:cursor-grabbing",
          props.className,
        )}
        data-editor-focus-view={props.tree.maximizedPaneId ? "true" : "false"}
        data-editor-tab-dragging={draggedTab ? "true" : "false"}
        onPointerDownCapture={(event) => {
          latestPointerCoordinatesRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMoveCapture={(event) => {
          latestPointerCoordinatesRef.current = { x: event.clientX, y: event.clientY };
        }}
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
            focusPulse={props.focusPulse ?? null}
            dropPreview={dropPreview}
          />
        ))}
        {layout.splits.map(({ split, bounds }) => (
          <PaneSplitHandle
            key={split.id}
            bounds={bounds}
            containerRef={containerRef}
            split={split}
            onResizePreview={(ratio) => previewSplitResize(split.id, ratio)}
            onResizeCommit={(ratio) => {
              resizePreviewRef.current = null;
              props.onResizeSplit(split.id, ratio);
            }}
            onResizeCancel={resetSplitResize}
          />
        ))}
      </div>
      <DragOverlay adjustScale={false} dropAnimation={null} zIndex={100}>
        {draggedTabLabel ? (
          <div
            aria-hidden
            className="pointer-events-none flex h-6 max-w-48 cursor-grabbing items-center rounded-md border border-primary/40 bg-popover px-2 text-xs text-foreground shadow-lg"
            data-editor-tab-drag-overlay=""
          >
            <span className="truncate">{draggedTabLabel}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface SplitPaneProps {
  bounds: PaneBounds;
  group: PaneNode;
  focusedPaneId: PaneId;
  renderPane: (group: PaneNode, tabDropPreview: PaneTabBarDropPreview | null) => ReactNode;
  onFocusPane: (paneId: PaneId) => void;
  tree: PaneTree;
  focusPulse: PaneFocusPulse | null;
  dropPreview: PaneDragDropPreview | null;
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
      {props.renderPane(
        group,
        props.dropPreview?._tag === "Tab" && props.dropPreview.paneId === group.id
          ? props.dropPreview
          : null,
      )}
      {props.focusPulse?.paneId === group.id ? (
        <span
          key={props.focusPulse.sequence}
          aria-hidden
          className="t3-pane-focus-ring pointer-events-none absolute inset-0 z-[60] ring-2 ring-inset ring-primary/80"
          data-editor-focus-pulse=""
        />
      ) : null}
      {props.dropPreview?._tag === "Pane" && props.dropPreview.paneId === group.id ? (
        <div className="pointer-events-none absolute inset-0 z-50">
          <PaneDropOverlay zone={props.dropPreview.zone} />
        </div>
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

function paneSplitStyle(bounds: PaneBounds, split: PaneSplitNode): CSSProperties {
  const splitPosition =
    split.orientation === "horizontal"
      ? bounds.left + (bounds.right - bounds.left) * split.ratio
      : bounds.top + (bounds.bottom - bounds.top) * split.ratio;
  return split.orientation === "horizontal"
    ? {
        top: `${bounds.top * 100}%`,
        left: `${splitPosition * 100}%`,
        height: `${(bounds.bottom - bounds.top) * 100}%`,
      }
    : {
        top: `${splitPosition * 100}%`,
        left: `${bounds.left * 100}%`,
        width: `${(bounds.right - bounds.left) * 100}%`,
      };
}

/** Updates only layout styles during a pointer resize so pane contents never reconcile per frame. */
function applyPaneTreeLayout(container: HTMLDivElement, tree: PaneTree): void {
  const layout = calculatePaneTreeLayout(getVisiblePaneTreeRoot(tree));
  const paneElements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>("[data-editor-group]")) {
    const paneId = element.dataset.editorGroup;
    if (paneId) paneElements.set(paneId, element);
  }
  const splitElements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>("[data-editor-split]")) {
    const splitId = element.dataset.editorSplit;
    if (splitId) splitElements.set(splitId, element);
  }

  for (const { group, bounds } of layout.groups) {
    const element = paneElements.get(group.id);
    if (element) Object.assign(element.style, paneBoundsStyle(bounds));
  }
  for (const { split, bounds } of layout.splits) {
    const element = splitElements.get(split.id);
    if (!element) continue;
    Object.assign(element.style, paneSplitStyle(bounds, split));
    element.setAttribute("aria-valuenow", String(Math.round(split.ratio * 100)));
  }
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
      style={paneSplitStyle(props.bounds, split)}
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

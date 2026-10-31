import { MoveHorizontalIcon, MoveVerticalIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import { settleStripCamera } from "../motion/stripCamera";
import {
  arrangeLayoutWorkspaces,
  LAYOUT_COLUMN_WIDTH_PRESETS,
  LAYOUT_MIN_COLUMN_WIDTH,
  LAYOUT_MIN_PANE_SIZE,
  LAYOUT_READABLE_COLUMN_PX,
  findLayoutPane,
  resizeLayoutColumn,
  resizeLayoutPane,
  type LayoutColumn,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutWorkspace,
} from "./layoutModel";
import { saveLayoutNow, useLayoutStore } from "./layoutStore";

/** Handles fill the gap between panes (the chrome gutter), centered on the boundary. */
const HANDLE_SIZE = "8px";
/**
 * The smallest usable column or stacked pane. A column grows up to the
 * strip's width; vertically stacked panes share their column's fixed height.
 */
const MIN_COLUMN_PX = LAYOUT_READABLE_COLUMN_PX;
const MIN_PANE_PX = 240;

const FRACTION_LABELS = new Map<number, string>([
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [1, "Full"],
]);

function fractionLabel(value: number, snapped: number | null): string {
  if (snapped !== null) return FRACTION_LABELS.get(snapped) ?? `${Math.round(value * 100)}%`;
  return `${Math.round(value * 100)}%`;
}

/** Preset snapping retained for the template editor, not strip pointer resizing. */
export function snapToPreset(
  raw: number,
  extentPx: number,
): { value: number; snapped: number | null } {
  for (const preset of LAYOUT_COLUMN_WIDTH_PRESETS) {
    if (Math.abs(raw - preset) * extentPx <= 12) {
      return { value: preset, snapped: preset };
    }
  }
  return { value: raw, snapped: null };
}

/** The next preset past `value` in `direction`, for keyboard resizing. */
function stepPreset(value: number, direction: 1 | -1): number {
  if (direction === 1) {
    return LAYOUT_COLUMN_WIDTH_PRESETS.find((preset) => preset > value + 1e-3) ?? value;
  }
  return LAYOUT_COLUMN_WIDTH_PRESETS.findLast((preset) => preset < value - 1e-3) ?? value;
}

/**
 * The shares an edge may move between: at least `minPx` for the resized
 * side and, when a neighbor gives up the difference, for the neighbor too.
 * A pair too small for both splits what it has.
 */
function edgeBounds(
  minPx: number,
  extentPx: number,
  pairTotal: number | null,
  floor: number,
): { min: number; max: number } {
  const wanted = Math.max(floor, minPx / extentPx);
  if (pairTotal === null) return { min: wanted, max: Number.POSITIVE_INFINITY };
  const min = Math.min(wanted, pairTotal / 2);
  return { min, max: pairTotal - min };
}

function clampToBounds(value: number, bounds: { min: number; max: number }): number {
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

type ActiveDrag =
  | {
      kind: "column";
      columnId: string;
      /** Where the column starts, in arranged widths from the strip's left edge. */
      columnLeft: number;
      /** The width its workspace is drawn against, in px: the unit column shares use. */
      unitWidth: number;
      contentLeft: number;
      scrollLeft: number;
      bounds: { min: number; max: number };
      value: number;
      snapped: number | null;
    }
  | {
      kind: "pane";
      paneId: string;
      columnLeft: number;
      columnWidth: number;
      /** Where the pane starts, as a share of the column's height. */
      paneTop: number;
      height: number;
      contentTop: number;
      bounds: { min: number; max: number };
      value: number;
      snapped: number | null;
    };

/**
 * Resize columns independently and stacked panes within their column.
 * Preview during the drag, then persist once on release; keyboard resizing uses presets.
 * Handles live in the scrolling strip so they stay aligned with pane edges.
 */
export function LayoutResizeHandles({
  layout,
  workspace,
  slots,
  stripWidth,
  unitWidth,
  scrollerRef,
  onPreview,
}: {
  layout: LayoutState;
  workspace: LayoutWorkspace;
  slots: readonly LayoutPaneSlot[];
  /** The strip's length in `unitWidth`s. */
  stripWidth: number;
  unitWidth: number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  onPreview: (layout: LayoutState | null) => void;
}) {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const baseLayoutRef = useRef<LayoutState>(layout);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, scrollLeft: 0 });

  const cancelFrame = () => {
    if (frameRef.current === null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };
  // The handles unmount mid-drag when the overview opens, a workspace switch
  // stacks the strip or the window narrows to one slot. The captured pointer's
  // release never reaches a detached node, so drop the drag's preview here.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending resize frame and releases the drag preview when its captured pointer target unmounts
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (dragRef.current !== null) onPreview(null);
    },
    [onPreview],
  );

  const updateDrag = (next: ActiveDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // A column drag arranges its workspace at the width it measures in, as its
  // release does, so the preview never jumps between fitting and scrolling.
  const applyDrag = (base: LayoutState, active: ActiveDrag): LayoutState =>
    active.kind === "column"
      ? arrangeLayoutWorkspaces(
          base,
          resizeLayoutColumn(base, active.columnId, active.value),
          active.unitWidth,
        )
      : resizeLayoutPane(base, active.paneId, active.value);

  const startDrag = (event: PointerEvent<HTMLDivElement>, active: ActiveDrag) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    baseLayoutRef.current = layout;
    pointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    };
    updateDrag(active);
  };

  const dragAtPointer = (active: ActiveDrag, event: PointerEvent<HTMLDivElement>): ActiveDrag => {
    if (active.kind === "column") {
      const scrollDelta =
        (scrollerRef.current?.scrollLeft ?? active.scrollLeft) - active.scrollLeft;
      const raw =
        (event.clientX - active.contentLeft + scrollDelta) / active.unitWidth - active.columnLeft;
      return { ...active, value: clampToBounds(raw, active.bounds), snapped: null };
    }
    const raw = (event.clientY - active.contentTop) / active.height - active.paneTop;
    return { ...active, value: clampToBounds(raw, active.bounds), snapped: null };
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active) return;
    pointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    };
    const next = dragAtPointer(active, event);
    if (next.value === active.value) return;
    dragRef.current = next;
    // Pointer streams can outpace paint. Lay out the strip once per frame,
    // always using the latest pointer, without dropping the release position.
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const latest = dragRef.current;
      if (!latest) return;
      setDrag(latest);
      onPreview(applyDrag(baseLayoutRef.current, latest));
    });
  };

  const finishDrag = (value?: ActiveDrag | null) => {
    const active = value === undefined ? dragRef.current : value;
    if (!active) return;
    cancelFrame();
    updateDrag(null);
    onPreview(null);
    const store = useLayoutStore.getState();
    if (active.kind === "column") {
      store.resizeColumnEdge(active.columnId, active.value, active.unitWidth);
    } else store.resizePane(active.paneId, active.value);
    saveLayoutNow();
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const pointer = pointerRef.current;
    const active =
      pointer.x === event.clientX &&
      pointer.y === event.clientY &&
      (dragRef.current.kind !== "column" ||
        pointer.scrollLeft === (scrollerRef.current?.scrollLeft ?? 0))
        ? dragRef.current
        : dragAtPointer(dragRef.current, event);
    finishDrag(active);
  };

  // Lands any camera move first: a drag measured against a scroll that
  // already landed while the handles still show mid-move would jump.
  const measure = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    settleStripCamera();
    const rect = scroller.getBoundingClientRect();
    return {
      height: scroller.clientHeight,
      contentLeft: rect.left - scroller.scrollLeft,
      contentTop: rect.top,
    };
  };

  const columns = workspace.columns;
  // Where each column is drawn, in arranged widths from the strip's left edge.
  // By pane id: a find per column is quadratic, and this runs every host render.
  const slotByPaneId = new Map(slots.map((slot) => [slot.paneId, slot]));
  const drawn = columns.map((column) => {
    const paneId = column.panes[0]?.id;
    const slot = paneId === undefined ? undefined : slotByPaneId.get(paneId);
    return {
      left: (slot?.rect.left ?? 0) * stripWidth,
      width: (slot?.rect.width ?? 0) * stripWidth,
    };
  });
  // No wider than the strip, so a column can always be wholly on screen.
  const columnBounds = () => ({
    ...edgeBounds(MIN_COLUMN_PX, unitWidth, null, LAYOUT_MIN_COLUMN_WIDTH),
    max: (scrollerRef.current?.clientWidth ?? unitWidth) / unitWidth,
  });
  const paneBounds = (panes: LayoutColumn["panes"], index: number, heightPx: number) =>
    edgeBounds(
      MIN_PANE_PX,
      heightPx,
      panes[index]!.size + panes[index + 1]!.size,
      LAYOUT_MIN_PANE_SIZE,
    );
  const handles: React.ReactNode[] = [];
  columns.forEach((column, columnIndex) => {
    const { left: thisColumnLeft, width } = drawn[columnIndex]!;
    const leftPct = (thisColumnLeft / stripWidth) * 100;
    const widthPct = (width / stripWidth) * 100;

    // Pane dividers inside the column.
    let paneTop = 0;
    column.panes.forEach((pane, paneIndex) => {
      const thisPaneTop = paneTop;
      paneTop += pane.size;
      if (paneIndex === column.panes.length - 1) return;
      handles.push(
        <div
          key={`pane:${pane.id}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize pane"
          aria-valuenow={Math.round(pane.size * 100)}
          tabIndex={0}
          className="absolute z-30 cursor-row-resize touch-none select-none outline-none [-webkit-app-region:no-drag] focus-visible:bg-ring/40"
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            top: `calc(${paneTop * 100}% - ${HANDLE_SIZE} / 2)`,
            height: HANDLE_SIZE,
          }}
          onPointerDown={(event) => {
            const metrics = measure();
            if (!metrics) return;
            startDrag(event, {
              kind: "pane",
              paneId: pane.id,
              columnLeft: thisColumnLeft,
              columnWidth: width,
              paneTop: thisPaneTop,
              height: metrics.height,
              contentTop: metrics.contentTop,
              bounds: paneBounds(column.panes, paneIndex, metrics.height),
              value: pane.size,
              snapped: null,
            });
          }}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => finishDrag()}
          onLostPointerCapture={() => finishDrag()}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const found = findLayoutPane(layout, pane.id);
            const metrics = measure();
            if (!found || !metrics) return;
            const step = stepPreset(found.pane.size, event.key === "ArrowDown" ? 1 : -1);
            useLayoutStore
              .getState()
              .resizePane(
                pane.id,
                clampToBounds(step, paneBounds(column.panes, paneIndex, metrics.height)),
              );
          }}
        />,
      );
    });

    // A lone column fills the window: no width to drag.
    if (columns.length === 1) return;
    handles.push(
      <div
        key={`column:${column.id}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column"
        aria-valuenow={Math.round(width * 100)}
        tabIndex={0}
        className="absolute inset-y-0 z-30 cursor-col-resize touch-none select-none outline-none [-webkit-app-region:no-drag] focus-visible:bg-ring/40"
        style={{
          left: `calc(${((thisColumnLeft + width) / stripWidth) * 100}% - ${HANDLE_SIZE} / 2)`,
          width: HANDLE_SIZE,
        }}
        onPointerDown={(event) => {
          const metrics = measure();
          if (!metrics) return;
          startDrag(event, {
            kind: "column",
            columnId: column.id,
            columnLeft: thisColumnLeft,
            unitWidth,
            contentLeft: metrics.contentLeft,
            scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
            bounds: columnBounds(),
            value: width,
            snapped: null,
          });
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => finishDrag()}
        onLostPointerCapture={() => finishDrag()}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = stepPreset(width, event.key === "ArrowRight" ? 1 : -1);
          useLayoutStore
            .getState()
            .resizeColumnEdge(column.id, clampToBounds(step, columnBounds()), unitWidth);
        }}
      />,
    );
  });

  return (
    <>
      {handles}
      {drag ? <ResizeFeedback drag={drag} stripWidth={stripWidth} /> : null}
    </>
  );
}

/**
 * The drag's guide line on the moving edge, the snap ticks along the strip's
 * bottom (column drags), and the pill naming the width (pen buCpT, KQQhW,
 * Fgh35). Static paint; it only moves with the pointer.
 */
function ResizeFeedback({ drag, stripWidth }: { drag: ActiveDrag; stripWidth: number }) {
  if (drag.kind === "column") {
    const edge = drag.columnLeft + drag.value;
    const toPct = (viewportUnits: number) => `${(viewportUnits / stripWidth) * 100}%`;
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 z-40">
        <div
          className="absolute top-13 bottom-12 w-0.5 -translate-x-1/2 rounded-full bg-strong-foreground"
          style={{ left: toPct(edge) }}
        />
        {LAYOUT_COLUMN_WIDTH_PRESETS.map((preset) => {
          const at = drag.columnLeft + preset;
          if (at > stripWidth) return null;
          return (
            <div
              key={preset}
              className={
                drag.snapped === preset
                  ? "absolute bottom-1 h-2 w-0.5 -translate-x-1/2 rounded-full bg-strong-foreground"
                  : "absolute bottom-1 h-2 w-0.5 -translate-x-1/2 rounded-full bg-strong-foreground/25"
              }
              style={{ left: toPct(at) }}
            />
          );
        })}
        <ResizePill
          style={{ left: toPct(edge), top: "58%" }}
          icon={<MoveHorizontalIcon className="size-3.25" />}
          label={`${fractionLabel(drag.value, drag.snapped)} width`}
        />
      </div>
    );
  }
  const edge = drag.paneTop + drag.value;
  const left = `${(drag.columnLeft / stripWidth) * 100}%`;
  const width = `${(drag.columnWidth / stripWidth) * 100}%`;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-40">
      <div
        className="absolute h-0.5 -translate-y-1/2 rounded-full bg-strong-foreground"
        style={{
          left: `calc(${left} + 52px)`,
          width: `calc(${width} - 104px)`,
          top: `${edge * 100}%`,
        }}
      />
      <ResizePill
        style={{ left: `calc(${left} + ${width} / 2)`, top: `${edge * 100}%` }}
        icon={<MoveVerticalIcon className="size-3.25" />}
        label={`${fractionLabel(drag.value, drag.snapped)} height`}
      />
    </div>
  );
}

function ResizePill({
  style,
  icon,
  label,
}: {
  style: React.CSSProperties;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div
      className="absolute flex h-6.5 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-control bg-strong-foreground px-2.5 text-meta whitespace-nowrap text-background shadow-drag-label"
      style={style}
    >
      {icon}
      {label}
    </div>
  );
}

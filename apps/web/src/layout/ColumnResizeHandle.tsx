import { MoveHorizontalIcon, MoveVerticalIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import { settleStripCamera } from "../motion/stripCamera";
import {
  LAYOUT_COLUMN_WIDTH_PRESETS,
  LAYOUT_MIN_COLUMN_WIDTH,
  LAYOUT_MIN_PANE_SIZE,
  LAYOUT_READABLE_COLUMN_PX,
  findLayoutPane,
  resizeLayoutColumnEdge,
  resizeLayoutPane,
  type LayoutColumn,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutWorkspace,
} from "./layoutModel";
import { getLayoutBehavior, useLayoutBehavior } from "./layoutBehavior";
import { saveLayoutNow, useLayoutStore } from "./layoutStore";

/**
 * A handle's hit width: a shared divider's 8px gutter, centered on it. Where each half of a
 * gutter owns one column's edge, its handle spans that half plus as much again into its pane,
 * so either way the pane's edge runs down the handle's middle.
 */
const HANDLE_SIZE = "8px";
/** Half the gutter: how far a pane's edge sits from its column's boundary beside a neighbor. */
const HALF_GAP_PX = 4;
/** Held this close to the strip's edge, a column drag keeps growing its column. */
const AUTOPAN_ZONE_PX = 32;
/** The growth rate at the strip's edge, in px per second; it ramps up across the zone. */
const AUTOPAN_MAX_PX_PER_S = 1200;
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

const MIN_KEYBOARD_STEP_PX = 12;

/** The first preset in `direction` that moves the edge visibly once clamped, for keyboard resizing. */
function stepPreset(
  value: number,
  direction: 1 | -1,
  bounds: { min: number; max: number },
  extentPx: number,
): number {
  const presets =
    direction === 1 ? LAYOUT_COLUMN_WIDTH_PRESETS : LAYOUT_COLUMN_WIDTH_PRESETS.toReversed();
  for (const preset of presets) {
    const next = clampToBounds(preset, bounds);
    if ((next - value) * direction * extentPx >= MIN_KEYBOARD_STEP_PX) return next;
  }
  return value;
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
      /** The strip's visible width in px: the unit column shares use. */
      unitWidth: number;
      drawnUnitWidth: number;
      /** The strip's left edge in client px, offset by where the pointer grabbed the edge. */
      contentLeft: number;
      scrollLeft: number;
      /** The strip's visible span in client px, for edge autopan. */
      view: { left: number; right: number };
      /** The pane a committed resize focuses; null when focus is already in the column. */
      focusPaneId: string | null;
      /** Where the moving pane edge sits from the column boundary, in px. */
      edgeOffsetPx: number;
      bounds: { min: number; max: number };
      value: number;
      snapped: number | null;
    }
  | {
      /** A column's start edge: it grows leftward and the strip scrolls with it. */
      kind: "columnStart";
      columnId: string;
      columnLeft: number;
      unitWidth: number;
      drawnUnitWidth: number;
      scrollLeft: number;
      view: { left: number; right: number };
      focusPaneId: string | null;
      edgeOffsetPx: number;
      startX: number;
      startValue: number;
      /** Growth from edge autopan, in px: the pointer holds still while the far edge moves. */
      panned: number;
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

type ResizeGuide =
  | {
      kind: "column" | "columnStart";
      columnLeft: number;
      edgeOffsetPx: number;
      value: number;
      snapped: number | null;
    }
  | {
      kind: "pane";
      columnLeft: number;
      columnWidth: number;
      paneTop: number;
      value: number;
      snapped: number | null;
    };

function presetAt(value: number): number | null {
  return LAYOUT_COLUMN_WIDTH_PRESETS.find((preset) => Math.abs(preset - value) < 1e-3) ?? null;
}

/**
 * Resize columns independently and stacked panes within their column. When columns may scroll,
 * each half of a divider owns the edge beside it: the left half the left column's end, the right
 * half the right column's start, which moves while the strip scrolls with it. Preview during the
 * drag and persist once on release; handles live in the strip so they stay aligned with pane edges.
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
  onPreview: (preview: { layout: LayoutState; heldStripPx: number } | null) => void;
}) {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const [keyboardHandle, setKeyboardHandle] = useState<string | null>(null);
  // Squeezed to fit, a divider trades width between its two columns instead.
  const splitEdges = useLayoutBehavior().whenNoRoom !== "always-shrink";
  const dragRef = useRef<ActiveDrag | null>(null);
  const baseLayoutRef = useRef<LayoutState>(layout);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, scrollLeft: 0 });
  const heldStripPxRef = useRef(0);
  const startValueRef = useRef(0);
  // The strip scroll a column resize needs once its resized strip is laid out.
  const pendingScrollRef = useRef<number | null>(null);
  // The edge autopan's frame loop, running only while a held drag sits in the edge zone.
  const autopanRef = useRef<{ frame: number; time: number } | null>(null);

  const cancelFrame = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (autopanRef.current !== null) cancelAnimationFrame(autopanRef.current.frame);
    autopanRef.current = null;
  };
  // The handles unmount mid-drag when the overview opens, a workspace switch
  // stacks the strip or the window narrows to one slot. The captured pointer's
  // release never reaches a detached node, so drop the drag's preview here.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending resize frames and releases the drag preview when its captured pointer target unmounts
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (autopanRef.current !== null) cancelAnimationFrame(autopanRef.current.frame);
      if (dragRef.current !== null) onPreview(null);
    },
    [onPreview],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM strip after the render that resized it, so a start edge stays put on screen
  useLayoutEffect(() => {
    const target = pendingScrollRef.current;
    const scroller = scrollerRef.current;
    if (target === null || !scroller) return;
    pendingScrollRef.current = null;
    if (Math.abs(scroller.scrollLeft - target) >= 0.5) scroller.scrollLeft = target;
  });

  // A start edge keeps its column's end still on screen, except for what autopan grew.
  const queueStartScroll = (active: ActiveDrag) => {
    if (active.kind !== "columnStart") return;
    pendingScrollRef.current =
      active.scrollLeft + (active.value - active.startValue) * active.unitWidth - active.panned;
  };
  // The scroll the strip has or is about to have: an end-edge drag measures against it.
  const stripScroll = () => pendingScrollRef.current ?? scrollerRef.current?.scrollLeft ?? 0;

  const updateDrag = (next: ActiveDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // A column drag arranges its workspace at the width it measures in, as its
  // release does, so the preview never jumps between fitting and scrolling.
  const applyDrag = (base: LayoutState, active: ActiveDrag): LayoutState =>
    active.kind !== "pane"
      ? resizeLayoutColumnEdge(
          base,
          active.columnId,
          active.value,
          getLayoutBehavior().whenNoRoom,
          active.unitWidth,
          active.drawnUnitWidth,
        )
      : resizeLayoutPane(base, active.paneId, active.value);

  const startDrag = (event: PointerEvent<HTMLDivElement>, active: ActiveDrag) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    baseLayoutRef.current = layout;
    startValueRef.current = active.value;
    heldStripPxRef.current = scrollerRef.current?.scrollWidth ?? 0;
    pointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    };
    updateDrag(active);
    if (active.kind !== "pane") {
      onPreview({ layout: applyDrag(layout, active), heldStripPx: heldStripPxRef.current });
    }
  };

  const dragAtPointer = (active: ActiveDrag, clientX: number, clientY: number): ActiveDrag => {
    if (active.kind === "columnStart") {
      const raw = active.startValue + (active.startX - clientX + active.panned) / active.unitWidth;
      return { ...active, value: clampToBounds(raw, active.bounds), snapped: null };
    }
    if (active.kind === "column") {
      const scrollDelta = stripScroll() - active.scrollLeft;
      const raw =
        (clientX - active.contentLeft + scrollDelta) / active.unitWidth - active.columnLeft;
      return { ...active, value: clampToBounds(raw, active.bounds), snapped: null };
    }
    const raw = (clientY - active.contentTop) / active.height - active.paneTop;
    return { ...active, value: clampToBounds(raw, active.bounds), snapped: null };
  };

  const showDrag = (latest: ActiveDrag) => {
    queueStartScroll(latest);
    setDrag(latest);
    onPreview({
      layout: applyDrag(baseLayoutRef.current, latest),
      heldStripPx: heldStripPxRef.current,
    });
  };

  // How fast a column drag held at the strip's edge grows its column, in px per second: only
  // toward growth, ramping up across the zone and past the edge, and 0 once the column is full.
  const autopanSpeed = (active: ActiveDrag, clientX: number) => {
    if (active.kind === "pane" || active.value >= active.bounds.max) return 0;
    const depth =
      active.kind === "column"
        ? clientX - (active.view.right - AUTOPAN_ZONE_PX)
        : active.view.left + AUTOPAN_ZONE_PX - clientX;
    return depth <= 0 ? 0 : AUTOPAN_MAX_PX_PER_S * Math.min(1, depth / AUTOPAN_ZONE_PX);
  };

  // Grows the column by `px` while its edge stays under the pointer: an end edge scrolls the
  // strip on with it, a start edge lets the column's end move instead.
  const panDrag = (active: ActiveDrag, px: number): ActiveDrag => {
    const { x, y } = pointerRef.current;
    if (active.kind === "columnStart") {
      // At its widest, keep only the pan that grew it.
      const room = (active.bounds.max - active.value) * active.unitWidth;
      const panned = active.panned + Math.max(0, Math.min(px, room));
      return dragAtPointer({ ...active, panned }, x, y);
    }
    if (active.kind === "pane") return active;
    const scroll = stripScroll();
    pendingScrollRef.current = scroll + px;
    const next = dragAtPointer(active, x, y);
    pendingScrollRef.current = scroll + (next.value - active.value) * active.unitWidth;
    return next;
  };

  const runAutopan = (time: number) => {
    const pan = autopanRef.current;
    const active = dragRef.current;
    if (!pan || !active) return;
    const speed = autopanSpeed(active, pointerRef.current.x);
    if (speed === 0) {
      autopanRef.current = null;
      return;
    }
    // Frame-rate independent; a stalled frame resumes without a leap.
    const elapsed = Math.min(50, Math.max(0, time - pan.time));
    pan.time = time;
    const next = panDrag(active, (speed * elapsed) / 1000);
    dragRef.current = next;
    if (next.value !== active.value) showDrag(next);
    pan.frame = requestAnimationFrame(runAutopan);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active) return;
    pointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    };
    const next = dragAtPointer(active, event.clientX, event.clientY);
    if (autopanRef.current === null && autopanSpeed(next, event.clientX) > 0) {
      autopanRef.current = {
        time: event.timeStamp,
        frame: requestAnimationFrame(runAutopan),
      };
    }
    if (next.value === active.value) return;
    dragRef.current = next;
    // Pointer streams can outpace paint. Lay out the strip once per frame,
    // always using the latest pointer, without dropping the release position.
    // A running autopan already lays it out every frame.
    if (frameRef.current !== null || autopanRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const latest = dragRef.current;
      if (latest) showDrag(latest);
    });
  };

  const finishDrag = (value?: ActiveDrag | null) => {
    const active = value === undefined ? dragRef.current : value;
    if (!active) return;
    cancelFrame();
    updateDrag(null);
    onPreview(null);
    // A press that never moved the edge (a click, or a double-click on the gutter) changes nothing.
    const extentPx = active.kind === "pane" ? active.height : active.unitWidth;
    if (Math.abs(active.value - startValueRef.current) * extentPx < 0.5) {
      pendingScrollRef.current = null;
      return;
    }
    queueStartScroll(active);
    const store = useLayoutStore.getState();
    if (active.kind === "pane") store.resizePane(active.paneId, active.value);
    else {
      // The resized column takes focus, so the camera keeps showing it rather than
      // springing back to a focused pane the resize pushed off screen.
      if (active.focusPaneId !== null) store.focusPane(active.focusPaneId);
      store.resizeColumnEdge(
        active.columnId,
        active.value,
        active.unitWidth,
        active.drawnUnitWidth,
      );
    }
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
        : dragAtPointer(dragRef.current, event.clientX, event.clientY);
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
      width: scroller.clientWidth,
      height: scroller.clientHeight,
      contentTop: rect.top,
      view: { left: rect.left, right: rect.left + scroller.clientWidth },
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
  const columnBounds = (unit: number) => ({
    ...edgeBounds(MIN_COLUMN_PX, unit, null, LAYOUT_MIN_COLUMN_WIDTH),
    max: (scrollerRef.current?.clientWidth ?? unit) / unit,
  });
  const paneBounds = (panes: LayoutColumn["panes"], index: number, heightPx: number) =>
    edgeBounds(
      MIN_PANE_PX,
      heightPx,
      panes[index]!.size + panes[index + 1]!.size,
      LAYOUT_MIN_PANE_SIZE,
    );
  // The column's pane at `share` of its height, unless focus is already in the column.
  const paneToFocus = (column: LayoutColumn, share: number) => {
    if (column.panes.some((pane) => pane.id === workspace.focusedPaneId)) return null;
    let bottom = 0;
    for (const pane of column.panes) {
      bottom += pane.size;
      if (share < bottom) return pane.id;
    }
    return column.panes.at(-1)?.id ?? null;
  };
  const handles: React.ReactNode[] = [];
  const keyboardGuides: ResizeGuide[] = [];
  const keyboardFocusProps = (key: string) => ({
    onFocus: (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.currentTarget.matches(":focus-visible")) setKeyboardHandle(key);
    },
    onBlur: () => setKeyboardHandle(null),
  });
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
      if (keyboardHandle === `pane:${pane.id}`) {
        keyboardGuides.push({
          kind: "pane",
          columnLeft: thisColumnLeft,
          columnWidth: width,
          paneTop: thisPaneTop,
          value: pane.size,
          snapped: presetAt(pane.size),
        });
      }
      handles.push(
        <div
          key={`pane:${pane.id}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize pane"
          aria-valuenow={Math.round(pane.size * 100)}
          tabIndex={0}
          className="absolute z-30 cursor-row-resize touch-none select-none outline-none [-webkit-app-region:no-drag]"
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
          {...keyboardFocusProps(`pane:${pane.id}`)}
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
            const step = stepPreset(
              found.pane.size,
              event.key === "ArrowDown" ? 1 : -1,
              paneBounds(column.panes, paneIndex, metrics.height),
              metrics.height,
            );
            useLayoutStore.getState().resizePane(pane.id, step);
          }}
        />,
      );
    });

    // A lone column fills the window: no width to drag.
    if (columns.length === 1) return;
    const columnHandle = (start: boolean, left: string, edgeOffsetPx: number) => {
      const key = `${start ? "columnStart" : "column"}:${column.id}`;
      const dragging =
        drag !== null &&
        drag.kind !== "pane" &&
        drag.columnId === column.id &&
        (drag.kind === "columnStart") === start;
      if (keyboardHandle === key) {
        keyboardGuides.push({
          kind: start ? "columnStart" : "column",
          edgeOffsetPx,
          columnLeft: thisColumnLeft,
          value: width,
          snapped: presetAt(width),
        });
      }
      handles.push(
        <div
          key={key}
          role="separator"
          aria-orientation="vertical"
          aria-label={start ? "Resize column start" : "Resize column"}
          aria-valuenow={Math.round(width * 100)}
          tabIndex={0}
          data-layout-gutter=""
          data-dragging={dragging || undefined}
          className="group/resize absolute inset-y-0 z-30 cursor-col-resize touch-none select-none outline-none [-webkit-app-region:no-drag]"
          style={{ left, width: HANDLE_SIZE }}
          onPointerDown={(event) => {
            const metrics = measure();
            if (!metrics || metrics.width <= 0) return;
            const scale = unitWidth / metrics.width;
            const edge = {
              columnId: column.id,
              columnLeft: thisColumnLeft * scale,
              unitWidth: metrics.width,
              drawnUnitWidth: unitWidth,
              scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
              view: metrics.view,
              edgeOffsetPx,
              focusPaneId: splitEdges
                ? paneToFocus(column, (event.clientY - metrics.contentTop) / metrics.height)
                : null,
              bounds: columnBounds(metrics.width),
              value: width * scale,
              snapped: null,
            };
            startDrag(
              event,
              start
                ? {
                    ...edge,
                    kind: "columnStart",
                    startX: event.clientX,
                    startValue: edge.value,
                    panned: 0,
                  }
                : {
                    ...edge,
                    kind: "column",
                    contentLeft: event.clientX - (edge.columnLeft + edge.value) * metrics.width,
                  },
            );
          }}
          {...keyboardFocusProps(key)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => finishDrag()}
          onLostPointerCapture={() => finishDrag()}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const grows = (event.key === "ArrowRight") !== start;
            const step = stepPreset(width, grows ? 1 : -1, columnBounds(unitWidth), unitWidth);
            if (step === width) return;
            const scroller = scrollerRef.current;
            if (start && scroller) {
              pendingScrollRef.current = scroller.scrollLeft + (step - width) * unitWidth;
            }
            useLayoutStore.getState().resizeColumnEdge(column.id, step, unitWidth);
          }}
        >
          <ResizeTarget />
        </div>,
      );
    };
    const endPct = ((thisColumnLeft + width) / stripWidth) * 100;
    // A shared divider gives each column the half of the gutter beside its own edge, and as
    // much again into its pane; a divider that trades width straddles the boundary.
    if (splitEdges && columnIndex > 0) columnHandle(true, `${leftPct}%`, HALF_GAP_PX);
    if (splitEdges && columnIndex < columns.length - 1) {
      columnHandle(false, `calc(${endPct}% - ${HANDLE_SIZE})`, -HALF_GAP_PX);
    } else columnHandle(false, `calc(${endPct}% - ${HANDLE_SIZE} / 2)`, 0);
  });
  const guide = drag ?? keyboardGuides[0];

  return (
    <>
      {handles}
      {guide ? <ResizeFeedback drag={guide} stripWidth={stripWidth} /> : null}
    </>
  );
}

/**
 * Which edge a column handle resizes: a faint tint over its hit area and a bar down the pane edge
 * it moves, shown on hover with a fine pointer, keyboard focus and while dragging. The bar sits
 * where the drag's guide line does, so pressing hands one to the other in place.
 */
function ResizeTarget() {
  return (
    <span
      aria-hidden
      data-resize-target=""
      className="pointer-events-none absolute inset-0 bg-strong-foreground/6 opacity-0 transition-opacity duration-100 ease-out group-focus-visible/resize:opacity-100 group-data-dragging/resize:opacity-100 group-data-dragging/resize:transition-none motion-reduce:transition-none pointer-fine:group-hover/resize:opacity-100"
    >
      <span className="absolute top-13 bottom-12 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-strong-foreground/50" />
    </span>
  );
}

/**
 * The drag's guide line on the moving edge and the pill naming the width
 * (pen buCpT, KQQhW, Fgh35). Static paint; it only moves with the pointer.
 */
function ResizeFeedback({ drag, stripWidth }: { drag: ResizeGuide; stripWidth: number }) {
  if (drag.kind !== "pane") {
    const edge = drag.kind === "columnStart" ? drag.columnLeft : drag.columnLeft + drag.value;
    const toPct = (viewportUnits: number) => `${(viewportUnits / stripWidth) * 100}%`;
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 z-40">
        <div
          className="absolute top-13 bottom-12 w-0.5 -translate-x-1/2 rounded-full bg-strong-foreground"
          style={{ left: `calc(${toPct(edge)} + ${drag.edgeOffsetPx}px)` }}
        />
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

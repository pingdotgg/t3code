import { useRef } from "react";

import {
  MIN_PANE_HEIGHT_PX,
  MIN_PANE_WIDTH_PX,
  minPaneFraction,
  resizeBoundary,
  snapShift,
} from "../../paneLayout";

const KEYBOARD_STEP = 0.02;

/** Space between two panes, as wide as the gap it replaces. */
const DIVIDER_THICKNESS = 6;

/**
 * A draggable boundary between two neighbours in a flex row (`column`) or the grid's rows (`row`).
 * Dragging rewrites the neighbours' flex-grow in the DOM and commits once on release, so six chats
 * are not re-rendered on every pointer move.
 */
export function PaneDivider({
  axis,
  onCommit,
  onReset,
}: {
  axis: "row" | "column";
  /** Total movement as a fraction of the container, with the smallest share a pane may keep. */
  onCommit: (delta: number, min: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{
    last: number;
    /** Pointer travel in pixels, before snapping. */
    raw: number;
    /** Snapped travel as a fraction, which is what gets applied and committed. */
    total: number;
    /** Pixel shifts this divider snaps to: equal neighbours, and dividers in other rows. */
    snapPoints: number[];
    before: HTMLElement;
    after: HTMLElement;
    start: [number, number];
    extent: number;
    min: number;
  } | null>(null);
  const horizontalBar = axis === "column";
  const minPx = horizontalBar ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
  // Fractions are shares of what is left after the dividers, so measure the same space.
  const center = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return horizontalBar ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
  };
  const snapPointsFor = (
    divider: HTMLElement,
    before: HTMLElement,
    after: HTMLElement,
    extent: number,
  ) => {
    const a = Number.parseFloat(before.style.flexGrow);
    const b = Number.parseFloat(after.style.flexGrow);
    const points = [((a + b) / 2 - a) * extent];
    // Lining up with a divider in another row keeps the grid looking tidy.
    const own = center(divider);
    for (const other of document.querySelectorAll(`[data-pane-divider="${axis}"]`)) {
      if (other !== divider && other.parentElement !== divider.parentElement) {
        points.push(center(other) - own);
      }
    }
    return points;
  };
  const measureExtent = (divider: HTMLElement) => {
    const parent = divider.parentElement;
    if (!parent) return 0;
    const bars = [...parent.children].filter((child) => child.getAttribute("role") === "separator");
    return (
      (horizontalBar ? parent.clientWidth : parent.clientHeight) - bars.length * DIVIDER_THICKNESS
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const before = event.currentTarget.previousElementSibling;
    const after = event.currentTarget.nextElementSibling;
    if (!(before instanceof HTMLElement) || !(after instanceof HTMLElement)) return;
    const extent = measureExtent(event.currentTarget);
    if (extent <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      last: horizontalBar ? event.clientX : event.clientY,
      raw: 0,
      total: 0,
      snapPoints: snapPointsFor(event.currentTarget, before, after, extent),
      before,
      after,
      start: [Number.parseFloat(before.style.flexGrow), Number.parseFloat(after.style.flexGrow)],
      extent,
      min: minPaneFraction(minPx, extent),
    };
    event.preventDefault();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const position = horizontalBar ? event.clientX : event.clientY;
    state.raw += position - state.last;
    state.last = position;
    const snap = event.altKey
      ? { shift: state.raw, snapped: false }
      : snapShift(state.raw, state.snapPoints);
    state.total = snap.shift / state.extent;
    event.currentTarget.toggleAttribute("data-snapped", snap.snapped);
    const [before, after] = resizeBoundary(state.start, 0, state.total, state.min);
    state.before.style.flexGrow = String(before);
    state.after.style.flexGrow = String(after);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    event.currentTarget.removeAttribute("data-snapped");
    if (state && state.total !== 0) onCommit(state.total, state.min);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = horizontalBar ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const direction = keys.indexOf(event.key);
    if (direction === -1) return;
    event.preventDefault();
    const min = minPaneFraction(minPx, measureExtent(event.currentTarget));
    onCommit(direction === 0 ? -KEYBOARD_STEP : KEYBOARD_STEP, min);
  };

  return (
    <div
      aria-label={horizontalBar ? "Resize panes horizontally" : "Resize panes vertically"}
      aria-orientation={horizontalBar ? "vertical" : "horizontal"}
      className={
        horizontalBar
          ? "w-1.5 shrink-0 cursor-col-resize touch-none rounded-full transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 active:bg-primary/40 data-snapped:bg-primary/60"
          : "h-1.5 shrink-0 cursor-row-resize touch-none rounded-full transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 active:bg-primary/40 data-snapped:bg-primary/60"
      }
      data-pane-divider={axis}
      data-testid="pane-divider"
      role="separator"
      tabIndex={0}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
    />
  );
}

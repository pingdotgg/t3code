import { resolveTimelineIsAtEnd } from "../components/chat/MessagesTimeline.logic";
import type { TimelineViewport } from "../components/chat/timelineViewport";
import { observeTimelineSelectionDrag } from "./timelineSelectionDrag";

const PROBE_TOP_PX = 30;
const PROBE_BOTTOM_PX = 300;
const PROBE_STEP_PX = 6;
const PROBE_LANE_FRACTIONS = [0.15, 0.3, 0.5] as const;
const PROBE_AGAIN_AFTER_PX = 24;
const PREFIX_LENGTH = 16;
const MIN_MOVE_PX = 0.5;
const QUIET_FRAMES = 2;
const MAX_FRAMES_AFTER_CHANGE = 30;
// An animated scroll writes one step per frame, so a scroll this recent may still be moving.
const MOVING_MS = 100;
// The timeline's own scroll can end with no scrollend, as when the browser cancels it.
const OWN_SCROLL_QUIET_MS = 250;
const ROW_SELECTOR = "[data-timeline-row-id]";
const CONTROL_SELECTOR =
  "button, input, select, textarea, [role='button'], [contenteditable=''], [contenteditable='true']";
const MEDIA_SELECTOR = "img, video, iframe, canvas, svg";

/** Who moves the timeline: live follow, the reader, or the timeline positioning it (find, a restore). */
export type TimelineScrollOwner = "follow" | "reader" | "positioning";

/** A character, which keeps its line when text rewraps, or the box of media with no text. */
type Mark =
  | {
      readonly kind: "text";
      readonly node: Text;
      readonly offset: number;
      /** The marked character and the ones before it; streamed text may grow after them only. */
      readonly prefix: string;
    }
  | { readonly kind: "box"; readonly element: Element };

interface ProbeHit {
  readonly mark: Mark;
  readonly row: HTMLElement;
}

/** What one probe point found: a mark in a row, or a control's bottom edge to scan past. */
type ProbePoint = ProbeHit | { readonly skipTo: number };

interface ReaderLine extends ProbeHit {
  readonly rowId: string | undefined;
  readonly threadKey: string;
  /** The mark's top, in px below the scroll node's top edge. */
  readonly y: number;
  /** The row's width when `y` was read; any other width means the text rewrapped since. */
  readonly rowWidth: number;
  readonly atEnd: boolean;
}

type ReaderLineState =
  | { readonly kind: "none" }
  | { readonly kind: "watching"; readonly line: ReaderLine }
  | {
      readonly kind: "holding";
      readonly line: ReaderLine;
      readonly frames: number;
      readonly quiet: number;
    };

export interface TimelineReaderLine {
  /** Reads the line again on the next frame, after rows changed; a recent probe miss stands. */
  readonly refresh: () => void;
  /** Takes the line afresh on the next frame, after the scroll came back to the reader. */
  readonly retake: () => void;
  /**
   * The timeline's own scroll by `top` px, smooth or instant, owns the scroll until it goes quiet
   * or the reader navigates. False while a width change is held: the caller measured a layout
   * still settling from that change, and skips its scroll.
   */
  readonly yieldToScroll: (top: number) => boolean;
  /**
   * While true, the list counts as away from its end: during a hold, and after a hold that ended
   * inside the end band until the reader navigates or follow resumes.
   */
  readonly keepsOffEnd: () => boolean;
  readonly dispose: () => void;
}

/**
 * Keeps the line the reader sees near the top of the timeline at the same place on screen when
 * the text column changes width, while the reader owns the scroll, nothing else is scrolling it,
 * and the list is not at its end.
 */
export function holdTimelineReaderLine({
  viewport,
  scrollOwner,
  threadKey,
  onHoldEnd,
}: {
  readonly viewport: Pick<TimelineViewport, "scrollNode" | "subscribe" | "holdProgrammaticScroll">;
  readonly scrollOwner: () => TimelineScrollOwner;
  readonly threadKey: () => string;
  /** Runs as a hold ends with the list in place, while `keepsOffEnd()` reports true. */
  readonly onHoldEnd: () => void;
}): TimelineReaderLine {
  const { scrollNode } = viewport;
  const doc = scrollNode.ownerDocument;
  const range = doc.createRange();
  let state: ReaderLineState = { kind: "none" };
  let observer: ResizeObserver | null = null;
  let observedRow: HTMLElement | null = null;
  let refreshFrame: number | null = null;
  let forceProbe = false;
  let tickFrame: number | null = null;
  let releaseWrite: (() => void) | null = null;
  // Where the last probe found no text: the scrollTop, and the rows at the probe band's two ends.
  let miss: {
    readonly at: number;
    readonly rows: ReadonlyArray<Element | null>;
    readonly shape: string;
  } | null = null;
  // The scrollTop this module last read or wrote, and when anything else last moved it.
  let knownTop = scrollNode.scrollTop;
  let movedAt = Number.NEGATIVE_INFINITY;
  // A quiet-spell timer, set while the timeline's own scroll owns the scroll.
  let ownScrollQuiet: ReturnType<typeof setTimeout> | null = null;
  // The thread whose last hold ended inside the end band.
  let offEndThread: string | null = null;
  const selectionDrag = observeTimelineSelectionDrag(scrollNode);

  // A hold would undo the timeline's own scroll, or the autoscroll of a selection being dragged.
  const readerHolds = () =>
    scrollOwner() === "reader" && ownScrollQuiet === null && !selectionDrag.isDragging();
  const sampleScrollTop = () => {
    const top = scrollNode.scrollTop;
    if (Math.abs(top - knownTop) >= MIN_MOVE_PX) movedAt = performance.now();
    knownTop = top;
  };
  const isMoving = () => performance.now() - movedAt < MOVING_MS;
  const markRect = (mark: Mark) => {
    if (mark.kind === "box") return mark.element.getBoundingClientRect();
    range.setStart(mark.node, mark.offset);
    range.setEnd(mark.node, mark.offset + 1);
    return range.getBoundingClientRect();
  };
  const markTop = (mark: Mark) => markRect(mark).top - scrollNode.getBoundingClientRect().top;
  // A hold that ends inside the end band leaves the list counted as away from its end.
  const isAtEnd = () =>
    offEndThread !== threadKey() &&
    resolveTimelineIsAtEnd({
      contentLength: scrollNode.scrollHeight,
      scroll: scrollNode.scrollTop,
      scrollLength: scrollNode.clientHeight,
    }) === true;
  const isValid = ({ mark, row, rowId, threadKey: key }: ReaderLine) =>
    row.isConnected &&
    row.dataset.timelineRowId === rowId &&
    key === threadKey() &&
    (mark.kind === "box"
      ? row.contains(mark.element)
      : row.contains(mark.node) &&
        mark.node.data.slice(mark.offset + 1 - mark.prefix.length, mark.offset + 1) ===
          mark.prefix);

  const releaseOwnWrite = () => {
    releaseWrite?.();
    releaseWrite = null;
  };
  const endHold = () => {
    if (tickFrame !== null) cancelAnimationFrame(tickFrame);
    tickFrame = null;
    releaseOwnWrite();
    if (state.kind === "holding") state = { kind: "watching", line: state.line };
  };
  const finishHold = () => {
    if (state.kind !== "holding") return;
    const { line } = state;
    onHoldEnd();
    endHold();
    if (isAtEnd()) offEndThread = line.threadKey;
    state = { kind: "watching", line: { ...line, atEnd: false } };
  };
  const drop = () => {
    endHold();
    if (observedRow) observer?.unobserve(observedRow);
    observedRow = null;
    state = { kind: "none" };
  };
  const watch = (line: ReaderLine) => {
    if (line.row !== observedRow) {
      // oxlint-disable-next-line t3code/no-raw-resize-observer -- sets no React state; it must run after LegendList's observer, which observeResize's shared one may precede
      observer ??= new ResizeObserver(onRowResize);
      if (observedRow) observer.unobserve(observedRow);
      observedRow = line.row;
      observer.observe(line.row, { box: "border-box" });
    }
    state = { kind: "watching", line };
  };
  const scheduleRefresh = (force = false) => {
    forceProbe ||= force;
    refreshFrame ??= requestAnimationFrame(runRefresh);
  };
  const stopYielding = () => {
    if (ownScrollQuiet !== null) clearTimeout(ownScrollQuiet);
    ownScrollQuiet = null;
  };
  const endOwnScroll = () => {
    if (ownScrollQuiet === null) return;
    stopYielding();
    scheduleRefresh(true);
  };
  const yieldUntilQuiet = () => {
    stopYielding();
    ownScrollQuiet = setTimeout(endOwnScroll, OWN_SCROLL_QUIET_MS);
  };

  // Where the rows lie in the content, and their heights.
  const shapeOf = (rows: ReadonlyArray<Element | null>) => {
    const origin = scrollNode.getBoundingClientRect().top - scrollNode.scrollTop;
    return rows
      .map((row) => {
        const rect = row?.getBoundingClientRect();
        return rect ? `${Math.round(rect.top - origin)}:${Math.round(rect.height)}` : "-";
      })
      .join(" ");
  };
  const recordMiss = () => {
    const view = scrollNode.getBoundingClientRect();
    const rows = [PROBE_TOP_PX, PROBE_BOTTOM_PX].map(
      (dy) =>
        doc.elementFromPoint(view.left + view.width / 2, view.top + dy)?.closest(ROW_SELECTOR) ??
        null,
    );
    return { at: scrollNode.scrollTop, rows, shape: shapeOf(rows) };
  };
  // A miss stands until the scroll moves far enough or the rows in the probe band change.
  const recentMiss = () =>
    miss !== null &&
    Math.abs(scrollNode.scrollTop - miss.at) < PROBE_AGAIN_AFTER_PX &&
    shapeOf(miss.rows) === miss.shape;

  const probeAt = (x: number, y: number, view: DOMRect): ProbePoint | null => {
    const caret = caretAt(doc, x, y);
    if (caret?.node instanceof Text) {
      const { node } = caret;
      const element = node.parentElement;
      const row = element?.closest<HTMLElement>(ROW_SELECTOR);
      if (element && row && scrollNode.contains(row)) {
        const control = element.closest(CONTROL_SELECTOR);
        if (control) {
          // The caret can snap to a control's text from a point beside it.
          const rect = control.getBoundingClientRect();
          if (rect.top <= y && rect.bottom >= y) return { skipTo: rect.bottom };
        } else {
          const scroller = nestedScroller(element, row);
          if (scroller) return { mark: { kind: "box", element: scroller }, row };
          const offset = markOffset(node, caret.offset);
          if (offset !== null) {
            const prefix = node.data.slice(Math.max(0, offset - PREFIX_LENGTH), offset + 1);
            const mark: Mark = { kind: "text", node, offset, prefix };
            if (spansInView(markRect(mark), y, view)) return { mark, row };
          }
        }
      }
    }
    const element = doc.elementFromPoint(x, y);
    const row = element?.closest<HTMLElement>(ROW_SELECTOR);
    if (!element || !row || !scrollNode.contains(row)) return null;
    const control = element.closest(CONTROL_SELECTOR);
    if (control) return { skipTo: control.getBoundingClientRect().bottom };
    const box = element.closest(MEDIA_SELECTOR) ?? nestedScroller(element, row);
    return box && row.contains(box) ? { mark: { kind: "box", element: box }, row } : null;
  };

  // Scans 30 to 300 px below the top edge at three points across the lane for a character fully
  // in view, past controls. With none, the first media box or nested scroller met stands in.
  const probe = (): ProbeHit | null => {
    const lane = scrollNode.querySelector("[data-timeline-root]")?.getBoundingClientRect();
    if (!lane) return null;
    const view = scrollNode.getBoundingClientRect();
    const skipUntil = PROBE_LANE_FRACTIONS.map(() => Number.NEGATIVE_INFINITY);
    let box: ProbeHit | null = null;
    for (let dy = PROBE_TOP_PX; dy <= PROBE_BOTTOM_PX; dy += PROBE_STEP_PX) {
      const y = view.top + dy;
      for (const [index, fraction] of PROBE_LANE_FRACTIONS.entries()) {
        if (y < skipUntil[index]!) continue;
        const point = probeAt(lane.left + lane.width * fraction, y, view);
        if (!point) continue;
        if ("skipTo" in point) {
          skipUntil[index] = point.skipTo;
        } else if (point.mark.kind === "text") {
          return point;
        } else {
          box ??= point;
          skipUntil[index] = markRect(point.mark).bottom;
        }
      }
    }
    return box;
  };

  const runRefresh = () => {
    if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
    refreshFrame = null;
    const force = forceProbe;
    forceProbe = false;
    if (state.kind === "holding") return;
    // Sees a step that another frame callback, such as a glide, wrote since the last scroll event.
    sampleScrollTop();
    if (scrollOwner() === "follow") {
      offEndThread = null;
      return drop();
    }
    const line = state.kind === "watching" && isValid(state.line) ? state.line : null;
    // The text already rewrapped and the observer has not reported it yet.
    if (line && Math.abs(line.row.getBoundingClientRect().width - line.rowWidth) > MIN_MOVE_PX)
      return;
    if (line) {
      const view = scrollNode.getBoundingClientRect();
      const rect = markRect(line.mark);
      const y = rect.top - view.top;
      // A text mark still under the first probe line is what a new probe would take.
      const kept =
        Math.abs(y - line.y) < MIN_MOVE_PX ||
        (line.mark.kind === "text"
          ? spansInView(rect, view.top + PROBE_TOP_PX, view)
          : !force && recentMiss());
      if (kept) {
        state = { kind: "watching", line: { ...line, y, atEnd: isAtEnd() } };
        return;
      }
    }
    if (!force && recentMiss()) return drop();
    const hit = probe();
    miss = hit?.mark.kind === "text" ? null : recordMiss();
    if (!hit) return drop();
    watch({
      ...hit,
      rowId: hit.row.dataset.timelineRowId,
      threadKey: threadKey(),
      y: markTop(hit.mark),
      rowWidth: hit.row.getBoundingClientRect().width,
      atEnd: isAtEnd(),
    });
  };

  const correct = (line: ReaderLine) => {
    const target = readerLineScrollTop(
      {
        scrollTop: scrollNode.scrollTop,
        scrollHeight: scrollNode.scrollHeight,
        clientHeight: scrollNode.clientHeight,
      },
      markTop(line.mark) - line.y,
    );
    if (target === null) return false;
    const from = scrollNode.scrollTop;
    releaseOwnWrite();
    releaseWrite = viewport.holdProgrammaticScroll();
    scrollNode.scrollTop = target;
    knownTop = scrollNode.scrollTop;
    // A write the browser rounds back to where it was fires no scroll event.
    if (scrollNode.scrollTop === from) releaseOwnWrite();
    return Math.abs(scrollNode.scrollTop - from) >= MIN_MOVE_PX;
  };
  // Requested again from each observer callback, so it queues after the frame work LegendList
  // requested in that pass (its shrink measurement, its anchor-locked MVCP).
  const scheduleTick = () => {
    if (tickFrame !== null) cancelAnimationFrame(tickFrame);
    tickFrame = requestAnimationFrame(tick);
  };
  const tick = () => {
    tickFrame = null;
    // A write's scroll event comes before the next frame's callbacks, or never.
    releaseOwnWrite();
    if (state.kind !== "holding") return;
    const { line } = state;
    if (!isValid(line) || !readerHolds()) {
      finishHold();
      return scheduleRefresh(true);
    }
    const moved = correct(line);
    const frames = state.frames + 1;
    const quiet = moved ? 0 : state.quiet + 1;
    state = { kind: "holding", line, frames, quiet };
    if (quiet >= QUIET_FRAMES || frames >= MAX_FRAMES_AFTER_CHANGE) finishHold();
    else scheduleTick();
  };

  // Chrome runs observers in creation order; Firefox in the order of their first observe since
  // they last had no targets. This one starts observing after LegendList's shared observer, which
  // keeps its targets while the list is mounted, so in both it runs after LegendList's adjust.
  function onRowResize(entries: ReadonlyArray<ResizeObserverEntry>) {
    // LegendList's own adjust for this resize has just run; it is not reader movement.
    knownTop = scrollNode.scrollTop;
    const entry = entries.at(-1);
    if (state.kind === "none" || entry?.target !== state.line.row) return;
    const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
    if (Math.abs(width - state.line.rowWidth) <= MIN_MOVE_PX) return;
    if (scrollOwner() === "follow") {
      offEndThread = null;
      return drop();
    }
    if (!isValid(state.line)) {
      drop();
      return scheduleRefresh(true);
    }
    const line = { ...state.line, rowWidth: width };
    // A correction while another scroll is moving the list would undo part of that scroll.
    const holds = readerHolds() && (state.kind === "holding" || (!line.atEnd && !isMoving()));
    if (holds) {
      state = { kind: "holding", line, frames: 0, quiet: 0 };
      correct(line);
      return scheduleTick();
    }
    if (state.kind === "holding") {
      state = { ...state, line };
      finishHold();
    } else {
      state = { kind: "watching", line };
    }
    // The layout is current here, so the next width change holds from where the text is now.
    forceProbe = true;
    runRefresh();
  }

  const handleScroll = () => {
    releaseOwnWrite();
    if (ownScrollQuiet !== null) yieldUntilQuiet();
    // Reader input during a hold comes as a navigation, which ends it.
    if (state.kind === "holding") {
      knownTop = scrollNode.scrollTop;
      return;
    }
    sampleScrollTop();
    scheduleRefresh();
  };
  // Registered after the viewport's own listener, so it sees a write's hold before this releases it.
  scrollNode.addEventListener("scroll", handleScroll, { passive: true });
  scrollNode.addEventListener("scrollend", endOwnScroll, { passive: true });
  const unsubscribe = viewport.subscribe((navigation) => {
    // A press on content moves nothing, and may open a panel that narrows the chat this turn.
    if (navigation.source === "pointer" && !navigation.onScrollbar) return;
    stopYielding();
    movedAt = performance.now();
    offEndThread = null;
    drop();
    scheduleRefresh();
  });

  return {
    refresh: () => scheduleRefresh(),
    retake: () => scheduleRefresh(true),
    yieldToScroll: (top) => {
      if (state.kind === "holding") return false;
      const end = scrollNode.scrollHeight - scrollNode.clientHeight;
      const target = Math.max(0, Math.min(scrollNode.scrollTop + top, end));
      if (Math.abs(target - scrollNode.scrollTop) >= 1) yieldUntilQuiet();
      return true;
    },
    keepsOffEnd: () =>
      state.kind === "holding" || (offEndThread === threadKey() && scrollOwner() !== "follow"),
    dispose: () => {
      endHold();
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      refreshFrame = null;
      stopYielding();
      selectionDrag.dispose();
      observer?.disconnect();
      observedRow = null;
      unsubscribe();
      scrollNode.removeEventListener("scroll", handleScroll);
      scrollNode.removeEventListener("scrollend", endOwnScroll);
      state = { kind: "none" };
    },
  };
}

/**
 * The scrollTop that moves the reader's line by `drift` as far as the scroll range allows, or
 * null when that moves it under half a pixel.
 */
export function readerLineScrollTop(
  geometry: {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  },
  drift: number,
): number | null {
  const end = geometry.scrollHeight - geometry.clientHeight;
  const target = Math.max(0, Math.min(geometry.scrollTop + drift, end));
  return Math.abs(target - geometry.scrollTop) < MIN_MOVE_PX ? null : target;
}

/** The standard caret API where it exists, else the WebKit one. */
function caretAt(doc: Document, x: number, y: number) {
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position && { node: position.offsetNode, offset: position.offset };
  }
  const caret = doc.caretRangeFromPoint(x, y);
  return caret && { node: caret.startContainer, offset: caret.startOffset };
}

/** The character at the caret, or the one before it at a node end or before whitespace. */
function markOffset(node: Text, caret: number): number | null {
  for (const offset of [caret, caret - 1]) {
    if (node.data[offset]?.trim()) return offset;
  }
  return null;
}

/** Whether `rect` spans the line `y` and lies fully inside `view`. */
function spansInView(rect: DOMRect, y: number, view: DOMRect) {
  return rect.top <= y && rect.bottom >= y && rect.top >= view.top && rect.bottom <= view.bottom;
}

/** A vertical scroller between `element` and its row: its inner scroll can move the text. */
function nestedScroller(element: Element, row: Element): Element | null {
  for (let current: Element | null = element; current && current !== row;) {
    const { overflowY } = getComputedStyle(current);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight + 1
    )
      return current;
    current = current.parentElement;
  }
  return null;
}

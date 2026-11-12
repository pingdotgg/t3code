import { type PointerEvent, useState } from "react";

export interface ResizeBounds {
  readonly min: number;
  readonly max: number;
}

interface ResizeSession {
  width: number;
  edge: "left" | "right";
  /** Pointer widths are clamped to these before `resize` sees them. */
  bounds: ResizeBounds;
  resize: (width: number) => number;
  finish: (width: number, moved: boolean) => void;
  cleanup?: (committed: boolean) => void;
}

function clampToBounds(width: number, bounds: ResizeBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, width));
}

interface ActiveDrag<T extends HTMLElement> {
  session: ResizeSession;
  target: T;
  pointerId: number;
  startX: number;
  pendingX: number;
  width: number;
  moved: boolean;
  frame: number | null;
  onBlur: () => void;
}

/** How far past the scrollbar a handle over its thumb still grabs it; beyond that it resizes. */
const THUMB_GRAB_OVERHANG_PX = 2;
/** Covers the thumb's rounded ends and Chromium's rounding of its position, so its ends grab it. */
const THUMB_GRAB_END_SLACK_PX = 4;

interface ScrollbarThumb {
  scroller: Element;
  scrollPerPixel: number;
  right: number;
}

interface ThumbDrag<T extends HTMLElement> {
  thumb: ScrollbarThumb;
  target: T;
  pointerId: number;
  startY: number;
  startScrollTop: number;
}

function scrollbarThumbAt(element: Element, x: number, y: number): ScrollbarThumb | null {
  const scrollRange = element.scrollHeight - element.clientHeight;
  if (scrollRange <= 0) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (style.overflowY !== "auto" && style.overflowY !== "scroll") return null;
  const gutterLeft = rect.left + element.clientLeft + element.clientWidth;
  const right = rect.right - Number.parseFloat(style.borderRightWidth);
  if (x < gutterLeft || x >= right) return null;
  const trackLength = element.clientHeight;
  const thumbLength = (trackLength * element.clientHeight) / element.scrollHeight;
  const thumbTop =
    rect.top + element.clientTop + ((trackLength - thumbLength) * element.scrollTop) / scrollRange;
  if (
    y < thumbTop - THUMB_GRAB_END_SLACK_PX ||
    y >= thumbTop + thumbLength + THUMB_GRAB_END_SLACK_PX
  ) {
    return null;
  }
  return { scroller: element, scrollPerPixel: scrollRange / (trackLength - thumbLength), right };
}

/**
 * Handles straddle pane edges and cover part of the neighbouring scrollbar. Next to its thumb the
 * handle grabs the thumb instead, which also widens the thumb's grab area a little.
 */
function scrollbarThumbBeside(handle: HTMLElement, x: number, y: number): ScrollbarThumb | null {
  const probeX = handle.getBoundingClientRect().left + 0.5;
  for (const element of document.elementsFromPoint(probeX, y)) {
    if (handle.contains(element)) continue;
    const thumb = scrollbarThumbAt(element, probeX, y);
    if (thumb) return x < thumb.right + THUMB_GRAB_OVERHANG_PX ? thumb : null;
  }
  return null;
}

function createResizeDrag<T extends HTMLElement>() {
  let drag: ActiveDrag<T> | null = null;
  let thumbDrag: ThumbDrag<T> | null = null;
  let hover: { handle: T; thumbScroller: Element | null } | null = null;

  const clearHover = () => {
    const active = hover;
    if (!active) return;
    hover = null;
    active.handle.removeEventListener("pointerleave", clearHover);
    delete active.handle.dataset.hoverZone;
    active.thumbScroller?.removeAttribute("data-scrollbar-thumb-hover");
  };

  // Handles style their resize cursor from `data-hover-zone="resize"` instead of plain hover, so
  // the resize cursor never flashes over a thumb. Over one, the handle lends the thumb its hover
  // colour, since it covers the thumb's own hover.
  const setHover = (handle: T, thumbScroller: Element | null) => {
    if (hover?.handle === handle && hover.thumbScroller === thumbScroller) return;
    clearHover();
    hover = { handle, thumbScroller };
    handle.dataset.hoverZone = thumbScroller ? "scrollbar-thumb" : "resize";
    thumbScroller?.setAttribute("data-scrollbar-thumb-hover", "");
    handle.addEventListener("pointerleave", clearHover);
  };

  const finishThumbDrag = () => {
    const active = thumbDrag;
    if (!active) return;
    window.removeEventListener("blur", finishThumbDrag);
    // Release can synchronously dispatch lostpointercapture.
    thumbDrag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    document.body.style.removeProperty("user-select");
  };

  const beginThumbDrag = (event: PointerEvent<T>, thumb: ScrollbarThumb) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // A press on the thumb reaches the scroller, which the chat timeline reads as the user taking
    // over its scroll. The handle took this press, so pass it on.
    thumb.scroller.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
      }),
    );
    // Releasing outside the window can skip pointerup.
    window.addEventListener("blur", finishThumbDrag);
    thumbDrag = {
      thumb,
      target: event.currentTarget,
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: thumb.scroller.scrollTop,
    };
    document.body.style.userSelect = "none";
  };

  const flush = () => {
    const active = drag;
    if (!active) return;
    const delta = (active.pendingX - active.startX) * (active.session.edge === "left" ? -1 : 1);
    if (Math.abs(delta) > 2) active.moved = true;
    active.width = active.session.resize(
      clampToBounds(active.session.width + delta, active.session.bounds),
    );
  };

  const finish = (commit: boolean) => {
    const active = drag;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    window.removeEventListener("blur", active.onBlur);
    if (commit) flush();
    // Release can synchronously dispatch lostpointercapture.
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    active.session.cleanup?.(commit);
    if (commit) active.session.finish(active.width, active.moved);
  };

  const end = (event: PointerEvent<T>, usePosition: boolean) => {
    if (thumbDrag?.pointerId === event.pointerId) {
      event.preventDefault();
      finishThumbDrag();
      return;
    }
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pendingX = event.clientX;
    finish(true);
  };

  return {
    ref: (node: T | null) =>
      node === null
        ? undefined
        : () => {
            finish(false);
            finishThumbDrag();
            clearHover();
          },
    cancel: () => finish(false),
    refresh(bounds?: ResizeBounds) {
      if (!drag) return;
      if (bounds) drag.session.bounds = bounds;
      flush();
    },
    begin(event: PointerEvent<T>, start: (event: PointerEvent<T>) => ResizeSession | null) {
      if (event.button !== 0 || drag || thumbDrag) return;
      if (event.pointerType === "mouse") {
        const thumb = scrollbarThumbBeside(event.currentTarget, event.clientX, event.clientY);
        if (thumb) return beginThumbDrag(event, thumb);
      }
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup?.(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Leaving the window mid-drag commits where the pointer was.
      const onBlur = () => finish(true);
      window.addEventListener("blur", onBlur);
      drag = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        pendingX: event.clientX,
        width: session.width,
        moved: false,
        frame: null,
        onBlur,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: PointerEvent<T>) {
      const scrolling = thumbDrag;
      if (scrolling) {
        if (scrolling.pointerId !== event.pointerId) return;
        event.preventDefault();
        scrolling.thumb.scroller.scrollTop =
          scrolling.startScrollTop +
          (event.clientY - scrolling.startY) * scrolling.thumb.scrollPerPixel;
        return;
      }
      const active = drag;
      if (!active && event.pointerType === "mouse") {
        const handle = event.currentTarget;
        setHover(
          handle,
          scrollbarThumbBeside(handle, event.clientX, event.clientY)?.scroller ?? null,
        );
      }
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      if (Math.abs(event.clientX - active.startX) > 2) active.moved = true;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: PointerEvent<T>) => end(event, true),
    onPointerCancel: (event: PointerEvent<T>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<T>) => end(event, false),
  };
}

/**
 * A pointer drag that resizes along one edge. The session `start` returns owns
 * everything the drag needs, so options read at pointer-down hold for the whole
 * drag. Attach `ref` to the handle so unmounting it abandons the drag.
 */
export function useResizeDrag<T extends HTMLElement>(
  start: (event: PointerEvent<T>) => ResizeSession | null,
) {
  // Created once: `ref` must keep its identity, or a re-render mid-drag would run its cleanup.
  const [drag] = useState(createResizeDrag<T>);
  const { begin, ...rest } = drag;
  return { ...rest, onPointerDown: (event: PointerEvent<T>) => begin(event, start) };
}

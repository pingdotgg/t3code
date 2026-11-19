// Chromium starts selection autoscroll this many device px inside a scroller's edge. Zoomed
// out, that is more CSS px; zoomed in, 20 CSS px still covers it.
const AUTOSCROLL_EDGE_DEVICE_PX = 20;

/**
 * Whether the browser is autoscrolling the timeline for a text selection the reader drags
 * to its top edge. That scroll comes with no wheel, key or touch event.
 */
export function observeTimelineSelectionDrag(scrollNode: HTMLElement): {
  readonly isActive: () => boolean;
  readonly dispose: () => void;
} {
  // Measured on each move, so layout moving under a still pointer is no drag.
  let press: { readonly pointerId: number; readonly atEdge: boolean } | null = null;
  const end = () => {
    press = null;
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerup", handlePointerEnd, true);
    window.removeEventListener("pointercancel", handlePointerEnd, true);
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== press?.pointerId) return;
    // A chorded press releases the primary button with a move, not a pointerup.
    if ((event.buttons & 1) === 0) end();
    else {
      const edge = AUTOSCROLL_EDGE_DEVICE_PX / Math.min(1, window.devicePixelRatio);
      const atEdge = event.clientY <= scrollNode.getBoundingClientRect().top + edge;
      press = { pointerId: event.pointerId, atEdge };
    }
  };
  const handlePointerEnd = (event: PointerEvent) => {
    if (event.pointerId === press?.pointerId) end();
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    end();
    press = { pointerId: event.pointerId, atEdge: false };
    // The drag goes on outside the timeline, and the release can land outside the window.
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: true });
    window.addEventListener("pointerup", handlePointerEnd, { capture: true, passive: true });
    window.addEventListener("pointercancel", handlePointerEnd, { capture: true, passive: true });
  };
  scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true });
  // A release in another window or tab reaches this page as a blur only.
  window.addEventListener("blur", end);
  return {
    // The browser's clamp after content shrinks moves scrollTop during a press too, but the
    // pointer is not dragging at the top edge then.
    isActive: () => {
      if (!press?.atEdge) return false;
      const selection = scrollNode.ownerDocument.getSelection();
      return (
        selection !== null && !selection.isCollapsed && scrollNode.contains(selection.anchorNode)
      );
    },
    dispose: () => {
      end();
      scrollNode.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("blur", end);
    },
  };
}

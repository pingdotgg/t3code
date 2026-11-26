import { observeResize } from "./observeResize";

/** Native anchoring keeps a paragraph's start fixed, losing the visible line in a long paragraph. */
export function preserveReadingPosition(
  scroller: HTMLElement,
  enabled: () => boolean = () => true,
): () => void {
  // Seeded by the observer's first report or an earlier scroll, never read here: that would force
  // a layout mid-commit. A resize before either is not corrected.
  let width: number | null = null;
  let anchor: { range: Range; top: number } | null = null;
  let frame: number | null = null;

  const capture = () => {
    width ??= scroller.clientWidth;
    if (frame !== null || scroller.clientWidth !== width) return;
    anchor = null;
    if (!enabled() || scroller.scrollTop === 0) return;
    const box = scroller.getBoundingClientRect();
    const selection =
      scroller.isContentEditable && document.activeElement === scroller
        ? document.getSelection()
        : null;
    if (selection?.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0).cloneRange();
      const rect = range.getBoundingClientRect();
      if (
        scroller.contains(range.startContainer) &&
        rect.top >= box.top &&
        rect.bottom <= box.bottom
      ) {
        anchor = { range, top: rect.top - box.top };
        return;
      }
    }
    // A point near the top captures text rather than the paragraph's bounding box.
    const x = box.left + box.width / 2;
    // The first point can land in paragraph spacing. Look only within the first few lines.
    for (let inset = Math.min(24, box.height / 2); inset < Math.min(64, box.height); inset += 8) {
      const y = box.top + inset;
      const position = document.caretPositionFromPoint?.(x, y);
      const range = document.createRange();
      if (position) {
        range.setStart(position.offsetNode, position.offset);
      } else {
        const fallback = document.caretRangeFromPoint?.(x, y);
        if (!fallback) continue;
        range.setStart(fallback.startContainer, fallback.startOffset);
      }
      range.collapse(true);
      if (
        !scroller.contains(range.startContainer) ||
        range.startContainer.nodeType !== Node.TEXT_NODE
      )
        continue;
      const top = range.getBoundingClientRect().top - box.top;
      if (top >= 0 && top < scroller.clientHeight) {
        anchor = { range, top };
        break;
      }
    }
  };
  const restore = () => {
    if (
      !enabled() ||
      !anchor ||
      anchor.range.startContainer.nodeType !== Node.TEXT_NODE ||
      !scroller.contains(anchor.range.startContainer)
    )
      return;
    const delta =
      anchor.range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
  };
  const stop = observeResize(scroller, () => {
    const nextWidth = scroller.clientWidth;
    if (width === null) width = nextWidth;
    if (nextWidth === width) {
      capture();
      return;
    }
    width = nextWidth;
    restore();
    if (frame !== null) cancelAnimationFrame(frame);
    // Virtualized rows can finish measuring in the next frame. Keep the same text anchor then.
    frame = requestAnimationFrame(() => {
      restore();
      frame = null;
      capture();
    });
  });
  scroller.addEventListener("scroll", capture, { passive: true });
  scroller.addEventListener("input", capture);
  const captureSelection = () => {
    if (document.activeElement === scroller) capture();
  };
  if (scroller.isContentEditable) document.addEventListener("selectionchange", captureSelection);
  const interrupt = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    anchor = null;
    // Scrolling wins over a pending resize correction; the next frame captures the reader's new place.
    frame = requestAnimationFrame(() => {
      frame = null;
      width = scroller.clientWidth;
      capture();
    });
  };
  scroller.addEventListener("wheel", interrupt, { passive: true });
  scroller.addEventListener("touchmove", interrupt, { passive: true });
  return () => {
    stop();
    if (frame !== null) cancelAnimationFrame(frame);
    scroller.removeEventListener("scroll", capture);
    scroller.removeEventListener("input", capture);
    document.removeEventListener("selectionchange", captureSelection);
    scroller.removeEventListener("wheel", interrupt);
    scroller.removeEventListener("touchmove", interrupt);
  };
}

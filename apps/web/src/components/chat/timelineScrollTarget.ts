// A gesture inside the timeline may belong to a nested tool result or code
// block. Only treat it as timeline navigation if it can chain to the outer list.
export function isTimelineScrollTarget(
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
): boolean {
  if (!(target instanceof Element) || !timeline.contains(target) || deltaY === 0) return false;

  for (
    let element: Element | null = target;
    element && element !== timeline;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;

    const canScroll =
      deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (
      canScroll ||
      style.overscrollBehaviorY === "contain" ||
      style.overscrollBehaviorY === "none"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Reports, for each timeline scroll, whether the reader moved it up. A scroll
 * that chains out of an embedded frame (an HTML render or MCP app) reaches the
 * timeline with no wheel, touch, or pointer event it can see. Following only
 * moves toward the end, and shrinking content can only pull the offset up by
 * clamping, so an upward move while the content kept its height is the reader.
 */
export function createUpwardScrollDetector(initial: { top: number; height: number }) {
  let baseline = initial;
  return (next: { top: number; height: number }) => {
    // Shrinking content or a move toward the end starts a new measurement.
    if (next.height < baseline.height || next.top > baseline.top) {
      baseline = next;
      return false;
    }
    if (next.top < baseline.top - 1) {
      baseline = next;
      return true;
    }
    // A slow scroll can move under a pixel per event; let those moves add up.
    baseline = { top: baseline.top, height: next.height };
    return false;
  };
}

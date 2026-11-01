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

// Sandboxed iframe gestures are invisible to the parent; only their chained scroll arrives.
export function createUpwardScrollDetector(initial: { top: number; height: number }) {
  let baseline = initial;
  return (next: { top: number; height: number; programmatic?: boolean }) => {
    if (next.programmatic || next.height < baseline.height || next.top > baseline.top) {
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

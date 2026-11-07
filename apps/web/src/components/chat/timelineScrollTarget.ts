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
export function createUpwardScrollDetector(initialOffset: number) {
  let baseline = initialOffset;
  return (next: { offset: number; maxOffset: number; programmatic: boolean }) => {
    if (next.programmatic || next.offset > baseline) baseline = next.offset;
    // Content shrinking below the view pulls the scroll up to the new end, and no further.
    else baseline = Math.min(baseline, next.maxOffset);
    // A slow scroll can move under a pixel per event; let those moves add up.
    if (next.offset >= baseline - 1) return false;
    baseline = next.offset;
    return true;
  };
}

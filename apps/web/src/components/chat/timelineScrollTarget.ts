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

export interface TimelineScrollPosition {
  readonly offset: number;
  readonly maxOffset: number;
}

export interface TimelineScrollAdjustment {
  readonly before: TimelineScrollPosition;
  readonly after: TimelineScrollPosition;
}

// Sandboxed iframe gestures are invisible to the parent; only their chained scroll arrives.
export function createUpwardScrollDetector(initial: TimelineScrollPosition) {
  let baseline = initial.offset;
  // Leaves any upward movement it cannot explain in the baseline for the next scroll event.
  const explain = (next: TimelineScrollPosition, programmatic: boolean) => {
    if (programmatic || next.offset > baseline) baseline = next.offset;
    // Content shrinking below the view pulls the scroll up to the new end.
    else baseline = Math.min(baseline, next.maxOffset);
  };
  return {
    scrolled: (next: TimelineScrollPosition, programmatic = false) => {
      explain(next, programmatic);
      // A slow scroll can move under a pixel per event; let those moves add up.
      if (next.offset >= baseline - 1) return false;
      baseline = next.offset;
      return true;
    },
    /** The list scrolled itself to keep content in place; that movement is not the reader's. */
    adjusted: (adjustment: TimelineScrollAdjustment, programmatic = false) => {
      explain(adjustment.before, programmatic);
      baseline += adjustment.after.offset - adjustment.before.offset;
    },
  };
}

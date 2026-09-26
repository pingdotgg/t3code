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

// Chromium keeps a run of wheel events on the scroller the run started on: a
// nested group that reaches its edge mid-run swallows the rest of the run, and
// the timeline only moves on a run that starts at that edge. With OS wheel input
// in Edge, clicks 400 ms apart stayed on the group and 800 ms apart chained;
// Chromium's own wheel transaction timeout is 500 ms.
export const TIMELINE_WHEEL_RUN_GAP_MS = 500;

export type TimelineWheelLatch = {
  targetsTimeline: boolean;
  lastEventAt: number;
};

export function createTimelineWheelLatch(): TimelineWheelLatch {
  return { targetsTimeline: false, lastEventAt: Number.NEGATIVE_INFINITY };
}

// Whether a wheel event scrolls the timeline, decided once per run by
// isTimelineScrollTarget on the run's first vertical event.
export function latchTimelineWheelTarget(
  latch: TimelineWheelLatch,
  event: Pick<WheelEvent, "target" | "deltaY" | "timeStamp">,
  timeline: HTMLElement,
): boolean {
  if (event.deltaY === 0) return false;
  if (event.timeStamp - latch.lastEventAt > TIMELINE_WHEEL_RUN_GAP_MS) {
    latch.targetsTimeline = isTimelineScrollTarget(event.target, timeline, event.deltaY);
  }
  latch.lastEventAt = event.timeStamp;
  return latch.targetsTimeline;
}

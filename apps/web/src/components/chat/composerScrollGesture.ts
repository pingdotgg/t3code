import { isTimelineScrollTarget } from "./timelineScrollTarget";

const COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX = 24;
export const COMPOSER_SCROLL_GESTURE_RESET_MS = 120;
const POINTER_SCROLL_TAIL_MS = 250;
const POINTER_SCROLL_RELEASE_EVENTS = [
  "pointerup",
  "pointercancel",
  "touchend",
  "touchcancel",
] as const;

export type ComposerScrollGestureState = {
  accumulatedDeltaPx: number;
  collapseSuppressed: boolean;
  lastEventAt: number;
};

export function shouldCollapseComposerForScrollKey(input: {
  key: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isAtLogicalEnd: boolean;
}): boolean {
  switch (input.key) {
    case "PageUp":
    case "Home":
      return input.scrollTop > 1;
    case "PageDown":
    case "End":
      return !input.isAtLogicalEnd && input.scrollTop < input.scrollHeight - input.clientHeight - 1;
    default:
      return false;
  }
}

export function createComposerScrollGestureState(): ComposerScrollGestureState {
  return {
    accumulatedDeltaPx: 0,
    collapseSuppressed: false,
    lastEventAt: Number.NEGATIVE_INFINITY,
  };
}

export function resetComposerScrollGesture(state: ComposerScrollGestureState): void {
  state.accumulatedDeltaPx = 0;
  state.collapseSuppressed = false;
  state.lastEventAt = Number.NEGATIVE_INFINITY;
}

export function suppressActiveComposerScrollGesture(
  state: ComposerScrollGestureState,
  now: number,
  gestureResetMs: number,
): void {
  if (now - state.lastEventAt <= gestureResetMs) {
    state.collapseSuppressed = true;
  }
}

export function recordComposerScrollGestureEvent(
  state: ComposerScrollGestureState,
  input: {
    now: number;
    deltaPx: number;
    collapseThresholdPx: number;
    collapseEligible: boolean;
    canScrollInGestureDirection: boolean;
    scrollsTowardLogicalEnd: boolean;
  },
): boolean {
  state.lastEventAt = input.now;
  if (
    state.collapseSuppressed ||
    !input.collapseEligible ||
    !input.canScrollInGestureDirection ||
    input.scrollsTowardLogicalEnd
  ) {
    state.accumulatedDeltaPx = 0;
    return false;
  }

  state.accumulatedDeltaPx += input.deltaPx;
  if (state.accumulatedDeltaPx < input.collapseThresholdPx) {
    return false;
  }

  state.accumulatedDeltaPx = 0;
  return true;
}

export function listenForComposerScrollGestures({
  gestureState,
  getTimelineScrollableNode,
  isTimelineAtLogicalEnd,
  isCollapseEligible,
  onCollapse,
  restoreAfterTimelineReachedEnd,
}: {
  gestureState: ComposerScrollGestureState;
  getTimelineScrollableNode: () => HTMLElement | null;
  isTimelineAtLogicalEnd: (scrollOffset?: number) => boolean;
  isCollapseEligible: () => boolean;
  onCollapse: () => void;
  restoreAfterTimelineReachedEnd: () => void;
}): () => void {
  let collapseTimeout: number | null = null;
  const finishScrollGesture = () => {
    if (collapseTimeout !== null) {
      window.clearTimeout(collapseTimeout);
    }
    collapseTimeout = null;
    resetComposerScrollGesture(gestureState);
  };
  const recordScrollGestureEvent = (
    input: Omit<Parameters<typeof recordComposerScrollGestureEvent>[1], "collapseThresholdPx">,
  ) => {
    if (collapseTimeout !== null) {
      window.clearTimeout(collapseTimeout);
    }
    collapseTimeout = window.setTimeout(finishScrollGesture, COMPOSER_SCROLL_GESTURE_RESET_MS);
    const shouldCollapse = recordComposerScrollGestureEvent(gestureState, {
      ...input,
      collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
    });
    if (shouldCollapse) {
      onCollapse();
    }
  };
  const handleTimelineWheel = (event: WheelEvent) => {
    endMiddleClickAutoscroll();
    if (event.ctrlKey || !(event.target instanceof Element)) {
      return;
    }

    const scrollNode = getTimelineScrollableNode();
    if (!scrollNode) return;
    const targetsTimeline = isTimelineScrollTarget(event.target, scrollNode, event.deltaY);
    if (!scrollNode.contains(event.target) && !gestureState.collapseSuppressed) return;

    const canScrollInGestureDirection =
      targetsTimeline &&
      (event.deltaY < 0
        ? scrollNode.scrollTop > 0
        : scrollNode.scrollTop < scrollNode.scrollHeight - scrollNode.clientHeight);
    const deltaPx =
      Math.abs(event.deltaY) *
      (event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scrollNode.clientHeight
          : 1);
    recordScrollGestureEvent({
      now: window.performance.now(),
      deltaPx,
      collapseEligible: targetsTimeline && isCollapseEligible(),
      canScrollInGestureDirection,
      scrollsTowardLogicalEnd: event.deltaY > 0 && isTimelineAtLogicalEnd(),
    });
  };

  let activeInput: "scrollbar" | "touch" | "middle-click" | null = null;
  let hasScrolled = false;
  let middleButtonReleasedAt: number | null = null;
  let touchScrollUntil = 0;
  let lastScrollTop = getTimelineScrollableNode()?.scrollTop ?? null;
  const beginPointerScroll = (input: NonNullable<typeof activeInput>, scrollNode: HTMLElement) => {
    activeInput = input;
    hasScrolled = false;
    middleButtonReleasedAt = null;
    touchScrollUntil = 0;
    lastScrollTop = scrollNode.scrollTop;
  };
  const cancelPointerScroll = () => {
    activeInput = null;
    touchScrollUntil = 0;
    hasScrolled = false;
    middleButtonReleasedAt = null;
  };
  const releasePointerScroll = (event: Event) => {
    // Native touch panning takes over the pointer stream, but keeps touch events.
    if (event.type === "pointercancel" && activeInput === "touch") return;
    if (event.type === "pointercancel" || event.type === "touchcancel" || event.type === "blur") {
      cancelPointerScroll();
      return;
    }
    if (activeInput === "middle-click") {
      // Chromium can suppress the pointerdown that stops toggle-mode autoscroll.
      if (
        event.type === "pointerup" &&
        event instanceof MouseEvent &&
        (hasScrolled || middleButtonReleasedAt !== null || event.button !== 1)
      ) {
        cancelPointerScroll();
      } else if (event.type === "pointerup") {
        middleButtonReleasedAt = window.performance.now();
      }
      return;
    }
    if (activeInput === "touch" && event.type === "touchend") {
      // Later scroll events must not extend the fling window.
      touchScrollUntil = hasScrolled ? window.performance.now() + POINTER_SCROLL_TAIL_MS : 0;
      activeInput = null;
    } else if (activeInput === "scrollbar" && event.type === "pointerup") {
      cancelPointerScroll();
    }
  };
  const endMiddleClickAutoscroll = () => {
    if (activeInput !== "middle-click") return false;
    cancelPointerScroll();
    return true;
  };
  const targetsTimeline = (target: EventTarget | null, scrollNode: HTMLElement) =>
    isTimelineScrollTarget(target, scrollNode, -1) && isTimelineScrollTarget(target, scrollNode, 1);
  const handleTimelinePointerDown = (event: PointerEvent) => {
    endMiddleClickAutoscroll();
    const scrollNode = getTimelineScrollableNode();
    if (!scrollNode) return;
    if (
      event.button === 1 &&
      event.target instanceof Element &&
      !event.target.closest("a[href]") &&
      targetsTimeline(event.target, scrollNode)
    ) {
      beginPointerScroll("middle-click", scrollNode);
    } else if (event.button === 0 && event.target === scrollNode && event.pointerType !== "touch") {
      beginPointerScroll("scrollbar", scrollNode);
    }
  };
  const handleTimelineTouchMove = (event: TouchEvent) => {
    const scrollNode = getTimelineScrollableNode();
    if (scrollNode && targetsTimeline(event.target, scrollNode) && activeInput !== "touch") {
      beginPointerScroll("touch", scrollNode);
    }
  };
  const handleTimelineScroll = (event: Event) => {
    const scrollNode = getTimelineScrollableNode();
    if (!scrollNode || event.target !== scrollNode) return;
    const scrollTop = scrollNode.scrollTop;
    const deltaY = lastScrollTop === null ? 0 : scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    const now = window.performance.now();
    // A browser without autoscroll must not leave a stationary middle click armed.
    if (
      activeInput === "middle-click" &&
      !hasScrolled &&
      middleButtonReleasedAt !== null &&
      now - middleButtonReleasedAt > COMPOSER_SCROLL_GESTURE_RESET_MS
    ) {
      cancelPointerScroll();
      return;
    }
    if (deltaY === 0 || (activeInput === null && now >= touchScrollUntil)) return;
    hasScrolled = true;

    // This capture listener runs before the list records the new offset,
    // so the list's end state can lag by one scroll step.
    const atLogicalEnd = deltaY > 0 && isTimelineAtLogicalEnd(scrollTop);
    if (atLogicalEnd) {
      restoreAfterTimelineReachedEnd();
    }
    recordScrollGestureEvent({
      now,
      deltaPx: Math.abs(deltaY),
      collapseEligible: isCollapseEligible(),
      // The offset already moved, so the timeline could scroll this way.
      canScrollInGestureDirection: true,
      scrollsTowardLogicalEnd: atLogicalEnd,
    });
  };

  document.addEventListener("wheel", handleTimelineWheel, { capture: true, passive: true });
  document.addEventListener("scroll", handleTimelineScroll, { capture: true, passive: true });
  document.addEventListener("pointerdown", handleTimelinePointerDown, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchmove", handleTimelineTouchMove, {
    capture: true,
    passive: true,
  });
  document.addEventListener("keydown", endMiddleClickAutoscroll, { capture: true });
  for (const type of POINTER_SCROLL_RELEASE_EVENTS) {
    window.addEventListener(type, releasePointerScroll, { capture: true, passive: true });
  }
  window.addEventListener("blur", releasePointerScroll);
  return () => {
    document.removeEventListener("wheel", handleTimelineWheel, true);
    document.removeEventListener("scroll", handleTimelineScroll, true);
    document.removeEventListener("pointerdown", handleTimelinePointerDown, true);
    document.removeEventListener("touchmove", handleTimelineTouchMove, true);
    document.removeEventListener("keydown", endMiddleClickAutoscroll, true);
    for (const type of POINTER_SCROLL_RELEASE_EVENTS) {
      window.removeEventListener(type, releasePointerScroll, true);
    }
    window.removeEventListener("blur", releasePointerScroll);
    finishScrollGesture();
  };
}

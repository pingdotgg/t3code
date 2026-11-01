import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../lib/utils";
import { canNavigateHistory, navigateHistory, type HistoryDirection } from "../navigationHistory";

const SWIPE_TRIGGER_DISTANCE = 120;
// Movement needed before the gesture picks an axis; first events are often diagonal.
const SWIPE_AXIS_LOCK_DISTANCE = 8;
const MOMENTUM_SAMPLE_SIZE = 5;

type SwipeBounds = { left: number; top: number; width: number; height: number };
type SwipeGesture =
  | { kind: "pending"; path: EventTarget[]; y: number; sumX: number; sumY: number }
  | {
      kind: "tracking";
      direction: HistoryDirection;
      distance: number;
      deltas: number[];
      y: number;
      bounds: SwipeBounds;
    }
  // Not a swipe, or one already decided: the rest of its events are ignored.
  | { kind: "ignored"; scrollerOwned?: true };
type SwipeIndicatorState = {
  direction: HistoryDirection;
  progress: number;
  y: number;
  bounds: SwipeBounds;
  tracking: boolean;
};

function readMainContentBounds(): SwipeBounds {
  const main = document.querySelector('[data-slot="sidebar-inset"]');
  if (!main) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const { left, top, width, height } = main.getBoundingClientRect();
  return { left, top, width, height };
}

// The composed path reaches scrollers inside shadow roots, such as the diff viewer's.
// A scroller at its edge still owns the gesture, so history never takes a content scroll.
function isInHorizontalScroller(path: readonly EventTarget[]): boolean {
  return path.some((element) => {
    if (!(element instanceof Element) || element.scrollWidth - element.clientWidth <= 1) {
      return false;
    }
    const { overflowX } = getComputedStyle(element);
    return overflowX === "auto" || overflowX === "scroll";
  });
}

function lockSwipeAxis(
  pending: Extract<SwipeGesture, { kind: "pending" }>,
): Exclude<SwipeGesture, { kind: "pending" }> {
  const { path, sumX, sumY } = pending;
  if (Math.abs(sumX) <= Math.abs(sumY)) return { kind: "ignored" };
  if (path.some((node) => node instanceof Element && node.matches('[role="dialog"]'))) {
    return { kind: "ignored" };
  }
  const direction = sumX < 0 ? "back" : "forward";
  if (!canNavigateHistory(direction)) return { kind: "ignored" };
  return {
    kind: "tracking",
    direction,
    distance: Math.abs(sumX),
    deltas: [],
    y: pending.y,
    bounds: readMainContentBounds(),
  };
}

/**
 * macOS momentum after the fingers lift decays by a near-constant ratio per
 * event; finger movement is noisier. Deltas are signed along the swipe.
 */
export function isMomentumTail(deltas: readonly number[]): boolean {
  if (deltas.length < MOMENTUM_SAMPLE_SIZE) return false;
  const recent = deltas.slice(-MOMENTUM_SAMPLE_SIZE);
  if (recent.some((delta) => delta <= 0)) return false;
  const ratios = recent.slice(1).map((delta, index) => delta / recent[index]!);
  return (
    ratios.every((ratio) => ratio >= 0.7 && ratio < 1) &&
    Math.max(...ratios) - Math.min(...ratios) < 0.1
  );
}

/** Two-finger horizontal trackpad swipes go back and forward, like a browser. */
export function HistorySwipeNavigation() {
  const [swipe, setSwipe] = useState<SwipeIndicatorState | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window wheel and desktop gesture listeners track trackpad swipes
  useEffect(() => {
    let gesture: SwipeGesture | null = null;
    let endedAt = Number.NEGATIVE_INFINITY;
    const hideIndicator = () =>
      setSwipe((current) => (current === null ? null : { ...current, tracking: false }));
    // The fingers lifted: navigate if the swipe went far enough, then ignore its momentum.
    const release = () => {
      if (gesture?.kind === "tracking" && gesture.distance >= SWIPE_TRIGGER_DISTANCE) {
        navigateHistory(gesture.direction);
      }
      gesture = { kind: "ignored" };
      hideIndicator();
    };
    // Scroll-begin IPC can arrive after the first wheel already gave ownership to content.
    const unsubscribeScrollBegin = window.desktopBridge?.onTrackpadScrollBegin(() => {
      if (gesture?.kind === "ignored" && !gesture.scrollerOwned) gesture = null;
    });
    const unsubscribeScrollEnd = window.desktopBridge?.onTrackpadScrollEnd((at) => {
      if (gesture?.kind === "tracking") release();
      gesture = null;
      // Wall time is the only clock main shares with the page. Converting on receipt keeps
      // sleep and clock changes out of the offset, leaving Date.now()'s 1ms resolution.
      endedAt = at - (Date.now() - performance.now());
    });
    const onWheel = (event: WheelEvent) => {
      // End IPC can overtake its gesture's last wheels. Those were created before main saw the
      // end; the next gesture's wheels usually come after, even when the IPC is slow.
      if (event.timeStamp < endedAt) return;
      if (gesture === null) {
        gesture =
          event.ctrlKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL
            ? { kind: "ignored" }
            : { kind: "pending", path: event.composedPath(), y: event.clientY, sumX: 0, sumY: 0 };
      }
      if (gesture.kind === "ignored") return;
      if (gesture.kind === "pending") {
        if (event.deltaX === 0 && event.deltaY === 0) return;
        const path = event.composedPath();
        // Claim content scrolling while its layout still exists, before a possible remount.
        if (isInHorizontalScroller(path)) {
          gesture = { kind: "ignored", scrollerOwned: true };
          return;
        }
        gesture.sumX += event.deltaX;
        gesture.sumY += event.deltaY;
        if (Math.abs(gesture.sumX) + Math.abs(gesture.sumY) < SWIPE_AXIS_LOCK_DISTANCE) return;
        gesture = lockSwipeAxis({ ...gesture, path: [...gesture.path, ...path] });
        if (gesture.kind === "ignored") return;
      } else {
        const delta = gesture.direction === "back" ? -event.deltaX : event.deltaX;
        if (event.deltaX === 0 && event.deltaY === 0) return release();
        gesture.deltas = [...gesture.deltas.slice(1 - MOMENTUM_SAMPLE_SIZE), delta];
        if (isMomentumTail(gesture.deltas)) return release();
        gesture.distance = Math.max(0, gesture.distance + delta);
      }
      setSwipe({
        direction: gesture.direction,
        progress: Math.min(1, gesture.distance / SWIPE_TRIGGER_DISTANCE),
        y: gesture.y,
        bounds: gesture.bounds,
        tracking: true,
      });
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      unsubscribeScrollBegin?.();
      unsubscribeScrollEnd?.();
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, []);

  return swipe === null ? null : <SwipeIndicator {...swipe} />;
}

// A circle pinned to the edge of the main content that peeks in up to half its width.
function SwipeIndicator({ direction, progress, y, bounds, tracking }: SwipeIndicatorState) {
  const armed = progress >= 1;
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  const hidden = 100 - progress * 50;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-100 overflow-hidden"
      style={bounds}
    >
      <div
        className={cn(
          "absolute flex size-14 items-center rounded-full bg-muted text-foreground dark:bg-black dark:text-white",
          direction === "back" ? "left-0 justify-end pr-2" : "right-0 justify-start pl-2",
          !tracking && "transition-[opacity,transform] duration-200 ease-out",
        )}
        style={{
          top: `clamp(0px, calc(${y - bounds.top}px - 1.75rem), calc(100% - 3.5rem))`,
          opacity: tracking ? 1 : 0,
          transform: `translateX(${direction === "back" ? -hidden : hidden}%)`,
        }}
      >
        <Icon
          className={cn(
            "size-4 transition-opacity duration-100",
            armed ? "opacity-100" : "opacity-40",
          )}
        />
      </div>
    </div>
  );
}

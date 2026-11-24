import type { TrackpadScrollPhase } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn, isMacPlatform } from "../lib/utils";
import { canNavigateHistory, navigateHistory, type HistoryDirection } from "../navigationHistory";

const SWIPE_TRIGGER_DISTANCE = 120;
// Movement needed before the gesture picks an axis; first events are often diagonal.
const SWIPE_AXIS_LOCK_DISTANCE = 8;
// Vertical scrolls drift sideways, so a swipe's horizontal travel must clearly dominate once
// it has moved far enough for its direction to be more than noise.
const SWIPE_HORIZONTAL_DOMINANCE = 2;
const SWIPE_DOMINANCE_DISTANCE = 30;
const MOMENTUM_SAMPLE_SIZE = 5;
const NATIVE_TIMESTAMP_TOLERANCE_MS = 4;

type NativeRelease = Extract<TrackpadScrollPhase, { kind: "end" }>;
type NativeContact = { at: number; ending?: NativeRelease };

type SwipeBounds = { left: number; top: number; width: number; height: number };
type SwipeGesture =
  | { kind: "pending"; path: EventTarget[]; y: number; sumX: number; sumY: number }
  | {
      kind: "tracking";
      direction: HistoryDirection;
      distance: number;
      deltas: number[];
      travelX: number;
      travelY: number;
      y: number;
      bounds: SwipeBounds;
    }
  // Not a swipe, or one already decided: the rest of its events are ignored.
  | { kind: "ignored" };
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

// `event.target` stops at a shadow host; the composed path also reaches scrollers inside it.
function hasHorizontalScroller(path: readonly EventTarget[]): boolean {
  for (const element of path) {
    if (!(element instanceof Element) || element.scrollWidth <= element.clientWidth) continue;
    const { overflowX } = getComputedStyle(element);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    return true;
  }
  return false;
}

function isVerticalScroll(travelX: number, travelY: number): boolean {
  return (
    travelX + travelY >= SWIPE_DOMINANCE_DISTANCE && travelX <= SWIPE_HORIZONTAL_DOMINANCE * travelY
  );
}

function lockSwipeAxis(
  pending: Extract<SwipeGesture, { kind: "pending" }>,
): Exclude<SwipeGesture, { kind: "pending" }> {
  const { path, sumX, sumY } = pending;
  if (Math.abs(sumX) <= Math.abs(sumY) || isVerticalScroll(Math.abs(sumX), Math.abs(sumY))) {
    return { kind: "ignored" };
  }
  // Preview contents can scroll in another document or on the server, outside this DOM.
  if (
    path.some(
      (node) =>
        node instanceof Element &&
        node.matches(
          '[role="dialog"], [role="alertdialog"], [data-preview-panel-mode], [data-preview-viewport], [data-server-browser-surface]',
        ),
    )
  ) {
    return { kind: "ignored" };
  }
  if (hasHorizontalScroller(path)) return { kind: "ignored" };
  const direction = sumX < 0 ? "back" : "forward";
  if (!canNavigateHistory(direction)) return { kind: "ignored" };
  return {
    kind: "tracking",
    direction,
    distance: Math.abs(sumX),
    deltas: [],
    travelX: Math.abs(sumX),
    travelY: Math.abs(sumY),
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

/**
 * Two-finger horizontal trackpad swipes go back and forward, like a browser.
 * macOS only: on Windows and Linux a mouse tilt wheel is indistinguishable from a trackpad swipe.
 */
export function HistorySwipeNavigation() {
  const [swipe, setSwipe] = useState<SwipeIndicatorState | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window wheel and desktop gesture listeners track trackpad swipes
  useEffect(() => {
    if (!isMacPlatform(navigator.platform)) return;
    let gesture: SwipeGesture | null = null;
    let gestureStartedAt = 0;
    let contact: NativeContact | "idle" | null = null;
    type UnclaimedWheel = { event: WheelEvent; path: EventTarget[] };
    let unclaimedWheels: UnclaimedWheel[] = [];
    let unclaimedFrame: number | undefined;
    let releaseFrame: number | undefined;

    const hideIndicator = () =>
      setSwipe((current) =>
        current === null || !current.tracking ? current : { ...current, tracking: false },
      );
    const release = (completed: boolean, native?: NativeRelease) => {
      const swipe = gesture;
      gesture = { kind: "ignored" };
      if (swipe?.kind !== "tracking") return;
      // The net native delta never exceeds the clamped wheel distance; it covers wheel events still in flight.
      const distance = native
        ? Math.max(swipe.distance, swipe.direction === "back" ? -native.deltaX : native.deltaX)
        : swipe.distance;
      if (
        completed &&
        distance >= SWIPE_TRIGGER_DISTANCE &&
        (!native || !isVerticalScroll(native.travelX, native.travelY))
      ) {
        navigateHistory(swipe.direction);
      }
      hideIndicator();
    };
    const clearReleaseFrame = () => {
      if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
      releaseFrame = undefined;
    };
    const clearUnclaimedWheel = () => {
      if (unclaimedFrame !== undefined) cancelAnimationFrame(unclaimedFrame);
      unclaimedFrame = undefined;
      unclaimedWheels = [];
    };
    const finishNativeContact = (ending: NativeRelease) => {
      clearReleaseFrame();
      contact = "idle";
      clearUnclaimedWheel();
      release(true, ending);
    };
    const cancelGesture = () => {
      if (contact === null && gesture === null) return;
      clearReleaseFrame();
      if (contact) contact = "idle";
      clearUnclaimedWheel();
      release(false);
    };

    // Chromium's scroll lifecycle includes momentum. AppKit phases take precedence when available.
    const unsubscribeScrollBegin = window.desktopBridge?.onTrackpadScrollBegin(() => {
      if (contact === null && gesture?.kind === "ignored") gesture = null;
    });
    const unsubscribeScrollEnd = window.desktopBridge?.onTrackpadScrollEnd(() => {
      if (contact !== null) return;
      release(true);
      gesture = null;
    });
    const onWheel = (event: WheelEvent, buffered?: UnclaimedWheel) => {
      const at = event.timeStamp;
      if (contact === "idle") {
        // IPC can arrive after the first wheel events of the next gesture; they still decide ownership.
        unclaimedWheels.push({ event, path: event.composedPath() });
        if (unclaimedFrame === undefined) {
          unclaimedFrame = requestAnimationFrame(clearUnclaimedWheel);
        }
        return;
      }
      if (
        contact &&
        (at < contact.at - NATIVE_TIMESTAMP_TOLERANCE_MS ||
          (contact.ending && at > contact.ending.at))
      )
        return;

      if (event.shiftKey) {
        if (gesture === null) gestureStartedAt = at;
        release(false);
        return;
      }
      if (gesture === null) {
        gestureStartedAt = at;
        gesture =
          event.ctrlKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL
            ? { kind: "ignored" }
            : {
                kind: "pending",
                path: buffered?.path ?? event.composedPath(),
                y: event.clientY,
                sumX: 0,
                sumY: 0,
              };
      }
      if (gesture.kind === "ignored") return;
      if (gesture.kind === "pending") {
        gesture.sumX += event.deltaX;
        gesture.sumY += event.deltaY;
        if (Math.abs(gesture.sumX) + Math.abs(gesture.sumY) < SWIPE_AXIS_LOCK_DISTANCE) return;
        gesture = lockSwipeAxis({
          ...gesture,
          path: [...gesture.path, ...(buffered?.path ?? event.composedPath())],
        });
        if (gesture.kind === "ignored") return;
      } else {
        const delta = gesture.direction === "back" ? -event.deltaX : event.deltaX;
        if (event.deltaX === 0 && event.deltaY === 0) {
          if (contact === null) release(true);
          return;
        }
        gesture.travelX += Math.abs(event.deltaX);
        gesture.travelY += Math.abs(event.deltaY);
        if (isVerticalScroll(gesture.travelX, gesture.travelY)) return release(false);
        if (contact === null) {
          gesture.deltas = [...gesture.deltas.slice(1 - MOMENTUM_SAMPLE_SIZE), delta];
          if (isMomentumTail(gesture.deltas)) return release(true);
        }
        gesture.distance = Math.max(0, gesture.distance + delta);
      }
      if (contact?.ending) return finishNativeContact(contact.ending);
      const { direction, distance, y, bounds } = gesture;
      const progress = Math.min(1, distance / SWIPE_TRIGGER_DISTANCE);
      setSwipe((current) =>
        current?.tracking &&
        current.direction === direction &&
        current.bounds === bounds &&
        current.progress === progress
          ? current
          : { direction, progress, y, bounds, tracking: true },
      );
    };
    const unsubscribeScrollPhase = window.desktopBridge?.onTrackpadScrollPhase?.((phase) => {
      // Translate the event wall time at receipt so sleep since page load cannot skew the match.
      const at = phase.at - Date.now() + performance.now();
      if (phase.kind === "begin") {
        const wheels = unclaimedWheels;
        clearUnclaimedWheel();
        clearReleaseFrame();
        if (contact !== null || gestureStartedAt < at - NATIVE_TIMESTAMP_TOLERANCE_MS) {
          if (gesture?.kind === "tracking") release(false);
          gesture = null;
        }
        contact = { at };
        for (const wheel of wheels) onWheel(wheel.event, wheel);
      } else if (phase.kind === "end" && contact && contact !== "idle") {
        if (gesture?.kind === "tracking" || gesture?.kind === "ignored") {
          finishNativeContact(phase);
        } else {
          // One frame lets an already queued wheel event establish scroll ownership.
          contact.ending = { ...phase, at };
          releaseFrame = requestAnimationFrame(() => finishNativeContact(phase));
        }
      } else if (phase.kind === "cancel") {
        cancelGesture();
      }
    });
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("blur", cancelGesture);
    window.navigation?.addEventListener("currententrychange", cancelGesture);
    return () => {
      clearUnclaimedWheel();
      clearReleaseFrame();
      unsubscribeScrollPhase?.();
      window.removeEventListener("blur", cancelGesture);
      window.navigation?.removeEventListener("currententrychange", cancelGesture);
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

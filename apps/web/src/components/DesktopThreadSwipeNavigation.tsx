import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../env";

type ThreadSwipeDirection = "previous" | "next";
type ThreadSwipeGesture = {
  direction: ThreadSwipeDirection;
  progress: number;
};

const SWIPE_THRESHOLD_PX = 120;
const SWIPE_IDLE_MS = 180;

function canScrollHorizontally(target: EventTarget | null): boolean {
  const firstElement =
    target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;

  for (
    let element = firstElement;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const overflowX = window.getComputedStyle(element).overflowX;
    if (
      /^(auto|scroll|overlay)$/.test(overflowX) &&
      element.scrollWidth > element.clientWidth + 1
    ) {
      return true;
    }
  }

  return false;
}

export function DesktopThreadSwipeNavigation(input: {
  navigate: (direction: ThreadSwipeDirection) => boolean;
}) {
  const navigateRef = useRef(input.navigate);
  const [gesture, setGesture] = useState<ThreadSwipeGesture | null>(null);

  useEffect(() => {
    navigateRef.current = input.navigate;
  }, [input.navigate]);

  useEffect(() => {
    if (!isElectron) return;

    let accumulatedDeltaX = 0;
    let didNavigate = false;
    let idleTimer: number | null = null;

    const reset = () => {
      accumulatedDeltaX = 0;
      didNavigate = false;
      idleTimer = null;
      setGesture(null);
    };

    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      const deltaX = event.deltaX;
      if (Math.abs(deltaX) < 2 || Math.abs(deltaX) <= Math.abs(event.deltaY) * 1.15) return;
      if (canScrollHorizontally(event.composedPath()[0] ?? event.target)) return;

      event.preventDefault();
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(reset, SWIPE_IDLE_MS);

      if (accumulatedDeltaX !== 0 && Math.sign(accumulatedDeltaX) !== Math.sign(deltaX)) {
        accumulatedDeltaX = 0;
        didNavigate = false;
      }
      accumulatedDeltaX += deltaX;

      const direction = accumulatedDeltaX > 0 ? "next" : "previous";
      setGesture({
        direction,
        progress: Math.min(Math.abs(accumulatedDeltaX) / SWIPE_THRESHOLD_PX, 1),
      });
      if (didNavigate || Math.abs(accumulatedDeltaX) < SWIPE_THRESHOLD_PX) return;

      didNavigate = true;
      navigateRef.current(direction);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
    };
  }, []);

  if (!isElectron || gesture === null) return null;

  const isPrevious = gesture.direction === "previous";
  const edgeOffset = (1 - gesture.progress) * 45;
  const arrowScale = 0.78 + gesture.progress * 0.22;
  const ArrowIcon = isPrevious ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <div
      key={gesture.direction}
      aria-hidden="true"
      className={`pointer-events-none fixed inset-y-0 z-[5] overflow-hidden ${
        isPrevious
          ? "right-0 left-0 md:left-[var(--sidebar-width)] md:group-data-[collapsible=offcanvas]:left-0"
          : "inset-x-0"
      }`}
    >
      <div
        data-desktop-thread-swipe-indicator={gesture.direction}
        data-desktop-thread-swipe-progress={gesture.progress.toFixed(2)}
        className={`absolute top-1/2 flex h-24 w-12 items-center justify-center border-primary/20 text-primary-foreground shadow-xl backdrop-blur-sm transition-[transform,background-color] duration-75 ease-out will-change-transform ${
          isPrevious
            ? "left-0 origin-left rounded-r-3xl border-y border-r"
            : "right-0 origin-right rounded-l-3xl border-y border-l"
        }`}
        style={{
          backgroundColor: `color-mix(in oklab, var(--primary) ${35 + gesture.progress * 65}%, transparent)`,
          transform: `translate3d(${isPrevious ? -edgeOffset : edgeOffset}%, -50%, 0)`,
        }}
      >
        <ArrowIcon
          className="size-6 drop-shadow-sm transition-transform duration-75 ease-out"
          strokeWidth={3}
          style={{ transform: `scale(${arrowScale})` }}
        />
      </div>
    </div>
  );
}

/**
 * Route mobile drawer swipes through touch events so browser scroll handling
 * cannot discard the gesture by cancelling its companion pointer stream.
 */
import { useEffect, useEffectEvent, type RefObject } from "react";

import {
  beginSidebarSwipe,
  endSidebarSwipe,
  moveSidebarSwipe,
  shouldClaimSidebarSwipe,
  type SidebarSwipeGesture,
} from "./sidebarSwipe.logic";

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/**
 * Code blocks and tables that scroll sideways own drags that start on them,
 * even though opening the drawer is otherwise available across the page.
 */
function startedOnHorizontalScroller(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  for (
    let element: Element | null = target;
    element !== null && element !== document.documentElement;
    element = element.parentElement
  ) {
    if (element === document.body) continue;
    const overflowX = getComputedStyle(element).overflowX;
    if (
      (overflowX === "auto" || overflowX === "scroll") &&
      element.scrollWidth > element.clientWidth + 1
    ) {
      return true;
    }
  }
  return false;
}

function isOpenSheetTarget(target: EventTarget | null, sheet: HTMLElement | null): boolean {
  if (sheet === null || !(target instanceof Node)) return false;
  const portal = sheet.closest("[data-slot='sheet-viewport']")?.parentElement;
  return (portal ?? sheet).contains(target);
}

/**
 * A drag that claims the pointer still ends with a click on the element
 * underneath, which would toggle the sheet back. Swallow that one click,
 * and drop the swallow if the browser never emits it.
 */
function suppressClickFromGesture() {
  const stopClick = (event: MouseEvent) => {
    if (event.detail === 0) {
      forget();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    forget();
  };
  const forget = () => {
    window.removeEventListener("click", stopClick, true);
    window.removeEventListener("pointerdown", forget, true);
    window.clearTimeout(timeout);
  };
  const timeout = window.setTimeout(forget, 700);
  window.addEventListener("click", stopClick, true);
  window.addEventListener("pointerdown", forget, true);
  return forget;
}

export function useSidebarSwipe(input: {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  sheetRef: RefObject<HTMLDivElement | null>;
  side?: "left" | "right";
  openFrom?: HTMLElement | null;
}) {
  const { enabled, sheetRef, side = "left" } = input;
  const readOpen = useEffectEvent(() => input.open);
  const canStartOpening = useEffectEvent((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    // A swipe on an existing sheet belongs only to that sheet, even when
    // its closing direction would open the drawer on the opposite side.
    if (
      target.closest("[data-slot='sheet-viewport'], [data-slot='sheet-backdrop'], [role='dialog']")
    ) {
      return false;
    }
    return input.openFrom === undefined || (input.openFrom?.contains(target) ?? false);
  });
  const commitOpen = useEffectEvent((open: boolean) => {
    input.setOpen(open);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers window touch and pointer listeners for the swipe gesture while mounted and removes them on cleanup
  useEffect(() => {
    if (!enabled) return;

    let gesture: SidebarSwipeGesture | null = null;
    let claimed = false;
    let clearSuppression: (() => void) | undefined;
    const projectX = (x: number) => (side === "right" ? -x : x);

    const reset = () => {
      gesture = null;
      claimed = false;
    };

    const resetFor = (pointerType: SidebarSwipeGesture["pointerType"]) => {
      if (gesture?.pointerType === pointerType) reset();
    };

    const start = (event: Event, pointerType: string, pointerId: number, x: number, y: number) => {
      if (gesture !== null) return;
      const intent = readOpen() ? "close" : "open";
      if (intent === "open" && !canStartOpening(event.target)) return;
      if (intent === "close" && !isOpenSheetTarget(event.target, sheetRef.current)) return;
      if (isTextEntry(event.target)) return;
      if (startedOnHorizontalScroller(event.target)) return;

      const next = beginSidebarSwipe({
        pointerType,
        pointerId,
        x: projectX(x),
        y,
        time: event.timeStamp,
        intent,
      });
      if (next === null) return;
      gesture = next;
      claimed = false;
    };

    const trackMove = (
      pointerType: SidebarSwipeGesture["pointerType"],
      pointerId: number,
      x: number,
      y: number,
      time: number,
      event: Event,
    ) => {
      if (
        gesture === null ||
        gesture.pointerType !== pointerType ||
        pointerId !== gesture.pointerId
      )
        return;
      gesture = moveSidebarSwipe(gesture, { x: projectX(x), y, time });
      if (!shouldClaimSidebarSwipe(gesture)) return;
      claimed = true;
      if (event.cancelable) event.preventDefault();
    };

    const finish = (
      pointerType: SidebarSwipeGesture["pointerType"],
      pointerId: number,
      x: number,
      y: number,
      time: number,
    ) => {
      if (
        gesture === null ||
        gesture.pointerType !== pointerType ||
        pointerId !== gesture.pointerId
      )
        return;
      const finished = moveSidebarSwipe(gesture, { x: projectX(x), y, time });
      const didClaim = claimed || shouldClaimSidebarSwipe(finished);
      if (endSidebarSwipe(finished) === "commit") {
        commitOpen(finished.intent === "open");
      }
      if (didClaim) {
        clearSuppression?.();
        clearSuppression = suppressClickFromGesture();
      }
      reset();
    };

    // Touch identifiers and pointer IDs are unrelated. Keep the full touch
    // lifecycle together, including touchend after a browser pointercancel.
    const onTouchStart = (event: TouchEvent) => {
      // Detached targets can hide the preceding release from window listeners.
      resetFor("touch");
      if (event.touches.length !== 1) return;
      const touch = event.changedTouches[0];
      if (touch) start(event, "touch", touch.identifier, touch.clientX, touch.clientY);
    };
    const findTouch = (event: TouchEvent) =>
      gesture?.pointerType === "touch"
        ? Array.from(event.changedTouches).find((touch) => touch.identifier === gesture?.pointerId)
        : undefined;
    const onTouchMove = (event: TouchEvent) => {
      const touch = findTouch(event);
      if (touch)
        trackMove("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event);
    };
    const onTouchEnd = (event: TouchEvent) => {
      const touch = findTouch(event);
      if (touch) finish("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !event.isPrimary) return;
      resetFor("pen");
      start(event, event.pointerType, event.pointerId, event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "pen") return;
      trackMove("pen", event.pointerId, event.clientX, event.clientY, event.timeStamp, event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== "pen") return;
      finish("pen", event.pointerId, event.clientX, event.clientY, event.timeStamp);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (
        event.pointerType === "pen" &&
        gesture?.pointerType === "pen" &&
        event.pointerId === gesture.pointerId
      )
        reset();
    };
    const onTouchCancel = (event: TouchEvent) => {
      if (findTouch(event)) reset();
    };

    // Capture before scroll areas or the dialog stop propagation. Only a
    // horizontal swipe prevents default; vertical gestures keep scrolling.
    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", onTouchEnd, true);
    window.addEventListener("touchcancel", onTouchCancel, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      clearSuppression?.();
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchCancel, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [enabled, sheetRef, side]);
}

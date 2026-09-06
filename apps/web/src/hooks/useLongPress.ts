import { type MouseEvent, type PointerEvent, useCallback, useEffect, useRef } from "react";

/** How long a touch must stay put before it counts as a long press. */
export const LONG_PRESS_MS = 500;

/**
 * How far a touch may drift and still count as a press rather than a scroll.
 * The sidebar scrolls, and people start scrolls with their finger on a row, so
 * anything past this belongs to the scroll rather than to the gesture.
 */
export const LONG_PRESS_MOVE_TOLERANCE = 10;

export type LongPressPosition = { readonly x: number; readonly y: number };

/**
 * Nested controls own their own press behavior — the PR badge, the archive
 * buttons, the rename input. A long press that starts on one of those is not
 * aimed at the row.
 */
const INTERACTIVE_DESCENDANTS = "button, a, input, textarea";

export function isInteractiveLongPressTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_DESCENDANTS) !== null;
}

export function exceedsMoveTolerance(start: LongPressPosition, next: LongPressPosition): boolean {
  return Math.hypot(next.x - start.x, next.y - start.y) > LONG_PRESS_MOVE_TOLERANCE;
}

/**
 * Touch long-press as a second way into an existing context menu.
 *
 * Desktop already opens thread actions with a right-click; touch has no
 * equivalent, so a stationary press stands in for one. The gesture is gated to
 * `pointerType === "touch"` so mouse and trackpad behavior is untouched, and it
 * calls whatever `onLongPress` does rather than owning any menu itself.
 *
 * Returns a bag of props to spread onto the pressable element:
 *
 *   const longPress = useLongPress(openRowContextMenu);
 *   <Row {...longPress} onClick={handleRowClick} />
 *
 * `onClickCapture` is part of the bag because Safari still delivers a click
 * after the press ends. Without swallowing it the menu would open and the row
 * would navigate at the same time.
 */
export function useLongPress(onLongPress: (position: LongPressPosition) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<LongPressPosition | null>(null);
  const firedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (event: PointerEvent) => {
      // A press that never reached its click leaves the suppression armed;
      // clearing it here keeps it from swallowing an unrelated later tap.
      firedRef.current = false;
      if (event.pointerType !== "touch") return;
      if (isInteractiveLongPressTarget(event.target)) return;

      cancel();
      const start = { x: event.clientX, y: event.clientY };
      startRef.current = start;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startRef.current = null;
        firedRef.current = true;
        onLongPress(start);
      }, LONG_PRESS_MS);
    },
    [cancel, onLongPress],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const start = startRef.current;
      if (start === null) return;
      if (exceedsMoveTolerance(start, { x: event.clientX, y: event.clientY })) {
        cancel();
      }
    },
    [cancel],
  );

  const onClickCapture = useCallback((event: MouseEvent) => {
    if (!firedRef.current) return;
    firedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture,
  };
}

/**
 * Pointer-capture drag gesture shared by the voice panel header and the
 * collapsed corner button. Reports movement as deltas from the press point
 * once a threshold is crossed; a release below the threshold ends with
 * `moved === false` so the caller can treat it as a tap.
 *
 * No rAF loop and no per-frame work beyond the pointermove handler itself,
 * matching the mini player's gesture model.
 */
import { useCallback, useRef } from "react";

export interface DragGestureOptions {
  readonly threshold: number;
  readonly onDragStart?: () => void;
  readonly onDragMove: (dx: number, dy: number) => void;
  readonly onDragEnd: (moved: boolean) => void;
}

export interface DragGestureHandlers {
  readonly onPointerDown: (event: React.PointerEvent) => void;
  readonly onPointerMove: (event: React.PointerEvent) => void;
  readonly onPointerUp: (event: React.PointerEvent) => void;
  readonly onPointerCancel: (event: React.PointerEvent) => void;
}

export function useDragGesture(options: DragGestureOptions): DragGestureHandlers {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gesture = useRef({ pointerId: -1, startX: 0, startY: 0, moved: false });

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const state = gesture.current;
    if (event.pointerId !== state.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.moved) {
      if (Math.hypot(dx, dy) <= optionsRef.current.threshold) return;
      state.moved = true;
      optionsRef.current.onDragStart?.();
    }
    optionsRef.current.onDragMove(dx, dy);
  }, []);

  const settle = useCallback((event: React.PointerEvent) => {
    const state = gesture.current;
    if (event.pointerId !== state.pointerId) return;
    const moved = state.moved;
    gesture.current = { pointerId: -1, startX: 0, startY: 0, moved: false };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    optionsRef.current.onDragEnd(moved);
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent) => settle(event), [settle]);
  const onPointerCancel = useCallback((event: React.PointerEvent) => settle(event), [settle]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

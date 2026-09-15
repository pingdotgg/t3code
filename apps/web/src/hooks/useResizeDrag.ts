import { type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef } from "react";

interface ResizeSession {
  width: number;
  axis?: "x" | "y";
  // Edge meaning is unchanged across axes: left subtracts the pointer delta, right adds it.
  edge: "left" | "right";
  resize: (width: number) => number;
  finish: (width: number, moved: boolean) => void;
  cleanup?: () => void;
}

/** Shared pointer lifecycle for side panels, including interrupted and sub-frame drags. */
export function useResizeDrag<T extends HTMLElement>(
  start: (event: PointerEvent<T>) => ResizeSession | null,
  resetKey?: string,
) {
  const drag = useRef<{
    session: ResizeSession;
    target: T;
    pointerId: number;
    startPosition: number;
    pendingPosition: number;
    width: number;
    moved: boolean;
    frame: number | null;
  } | null>(null);

  const flush = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    const delta =
      (active.pendingPosition - active.startPosition) * (active.session.edge === "left" ? -1 : 1);
    active.moved ||= Math.abs(delta) > 2;
    active.width = active.session.resize(active.session.width + delta);
  }, []);

  const finish = useCallback(
    (commit = true) => {
      const active = drag.current;
      if (!active) return;
      if (active.frame !== null) cancelAnimationFrame(active.frame);
      if (commit) flush();
      // Release can synchronously dispatch lostpointercapture.
      drag.current = null;
      try {
        if (active.target.hasPointerCapture(active.pointerId)) {
          active.target.releasePointerCapture(active.pointerId);
        }
      } catch {
        // Capture may already have been released by the browser.
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      active.session.cleanup?.();
      if (commit) active.session.finish(active.width, active.moved);
    },
    [flush],
  );

  const previousResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (previousResetKey.current !== resetKey) {
      finish(false);
      previousResetKey.current = resetKey;
    }
  }, [finish, resetKey]);

  useEffect(() => {
    const onBlur = () => finish();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      finish(false);
    };
  }, [finish]);

  const end = (event: PointerEvent<T>, usePosition: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) {
      active.pendingPosition = active.session.axis === "y" ? event.clientY : event.clientX;
    }
    finish();
  };

  return {
    onPointerDown(event: PointerEvent<T>) {
      if (event.button !== 0 || drag.current) return;
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup?.();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const position = session.axis === "y" ? event.clientY : event.clientX;
      drag.current = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startPosition: position,
        pendingPosition: position,
        width: session.width,
        moved: false,
        frame: null,
      };
      document.body.style.cursor = session.axis === "y" ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: PointerEvent<T>) {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      const position = active.session.axis === "y" ? event.clientY : event.clientX;
      active.pendingPosition = position;
      active.moved ||= Math.abs(position - active.startPosition) > 2;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: PointerEvent<T>) => end(event, true),
    onPointerCancel: (event: PointerEvent<T>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<T>) => end(event, false),
  };
}

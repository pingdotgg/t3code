import { type PointerEvent, useCallback, useEffect, useRef } from "react";

interface ResizeSession {
  width: number;
  edge: "left" | "right";
  resize: (width: number) => number;
  finish: (width: number, moved: boolean) => void;
  cleanup?: () => void;
}

/** Shared pointer lifecycle for side panels, including interrupted and sub-frame drags. */
export function useResizeDrag<T extends HTMLElement>(
  start: (event: PointerEvent<T>) => ResizeSession | null,
) {
  const drag = useRef<{
    session: ResizeSession;
    target: T;
    pointerId: number;
    startX: number;
    pendingX: number;
    width: number;
    moved: boolean;
    frame: number | null;
  } | null>(null);

  const flush = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    const delta = (active.pendingX - active.startX) * (active.session.edge === "left" ? -1 : 1);
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
    if (usePosition) active.pendingX = event.clientX;
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
      drag.current = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        pendingX: event.clientX,
        width: session.width,
        moved: false,
        frame: null,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: PointerEvent<T>) {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      active.moved ||= Math.abs(event.clientX - active.startX) > 2;
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

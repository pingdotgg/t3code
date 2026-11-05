import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { loomScale, panLoomView, zoomLoomView, type LoomView } from "./loomScale";

/**
 * Wheel zoom (ctrl or meta) and horizontal wheel pan on `wheelRef`, plus drag-to-pan pointer
 * handlers for an SVG. The timeline starts `leftInset` px into the wheel element.
 */
export function useLoomViewGestures(args: {
  readonly wheelRef: RefObject<HTMLElement | null>;
  readonly view: LoomView;
  readonly bounds: LoomView;
  readonly width: number;
  readonly leftInset: number;
  readonly onViewChange: (view: LoomView) => void;
}) {
  const { wheelRef, view, bounds, width, leftInset, onViewChange } = args;
  const onWheel = useStableCallback((event: WheelEvent) => {
    const element = wheelRef.current;
    if (element === null || width === 0) return;
    const x = event.clientX - element.getBoundingClientRect().left - leftInset;
    if (x < 0) return;
    const scale = loomScale(view, width);
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      onViewChange(zoomLoomView(view, bounds, scale.ms(x), Math.exp(event.deltaY * 0.002)));
    } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      onViewChange(panLoomView(view, bounds, delta * scale.msPerPx));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a non-passive wheel listener, since React's passive one cannot preventDefault for zoom
  useEffect(() => {
    const element = wheelRef.current;
    if (element === null) return;
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onWheel, wheelRef]);

  const drag = useRef<{ x: number; view: LoomView } | null>(null);
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    drag.current = { x: event.clientX, view };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (start === null || width === 0) return;
    const { msPerPx } = loomScale(start.view, width);
    onViewChange(panLoomView(start.view, bounds, (start.x - event.clientX) * msPerPx));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  return { onPointerDown, onPointerMove, onPointerUp };
}

import { useEffect, useEffectEvent, type RefObject } from "react";

type PinchPoint = { readonly x: number; readonly y: number };
type PinchHandler = (factor: number, point: PinchPoint) => void;

/** Chromium reports trackpad pinches as ctrl+wheel; deltaY maps to a multiplicative zoom step. */
function pinchZoomFactor(event: WheelEvent, pageHeight: number): number {
  const delta =
    event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1);
  return Math.exp(-delta * 0.01);
}

/**
 * Consumes pinch gestures on `target` before Chromium zooms the whole app.
 * Points are relative to `target`'s top-left; iframe windows already report frame-relative coordinates.
 */
export function listenForPinch(target: HTMLElement | Window, onPinch: PinchHandler): () => void {
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    const element = "getBoundingClientRect" in target ? target : null;
    const bounds = element?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const height = element ? element.clientHeight : (target as Window).innerHeight;
    onPinch(pinchZoomFactor(event, height), {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  };
  target.addEventListener("wheel", wheel as EventListener, { passive: false });
  return () => target.removeEventListener("wheel", wheel as EventListener);
}

/** Zooms a scroll container with trackpad pinch; the handler receives the step and pointer position. */
export function usePinchZoom(ref: RefObject<HTMLElement | null>, onPinch: PinchHandler) {
  const handle = useEffectEvent((factor: number, point: PinchPoint) => onPinch(factor, point));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A non-passive listener consumes pinch gestures before Chromium zooms the app.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    return listenForPinch(node, (factor, point) => handle(factor, point));
  }, [ref]);
}

import type { BrowserSurfaceRect } from "./browserSurfaceStore";

const NATIVE_SURFACE_OVERLAY_SELECTOR = [
  '[data-slot="menu-positioner"]',
  '[data-slot="popover-positioner"]',
  '[data-slot="select-positioner"]',
  '[data-slot="combobox-positioner"]',
  '[data-slot="autocomplete-positioner"]',
  '[data-slot="dialog-viewport"]',
  '[data-slot="sheet-viewport"]',
  '[data-slot="alert-dialog-viewport"]',
  '[data-slot="command-dialog-viewport"]',
  '[data-slot="tooltip-positioner"]',
  '[data-slot="toast-viewport"]',
  '[data-slot="toast-positioner"]',
  "[data-native-surface-overlay]",
].join(",");

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function rectanglesIntersect(left: RectLike, right: RectLike): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

/** Keep the native view live until React has committed its replacement frame. */
export function shouldPresentNativeSurface(
  active: boolean,
  surfaceOccluded: boolean,
  hasOcclusionFrame: boolean,
): boolean {
  return active && (!surfaceOccluded || !hasOcclusionFrame);
}

function surfaceRectToEdges(rect: BrowserSurfaceRect): RectLike {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
}

function isRendered(element: Element): boolean {
  if (element.closest("[hidden], [aria-hidden='true']")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export function isNativeSurfaceOccluded(rect: BrowserSurfaceRect): boolean {
  const surface = surfaceRectToEdges(rect);
  for (const overlay of document.querySelectorAll(NATIVE_SURFACE_OVERLAY_SELECTOR)) {
    if (!isRendered(overlay)) continue;
    const bounds = overlay.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0 && rectanglesIntersect(surface, bounds)) return true;
  }
  return false;
}

export function subscribeToNativeSurfaceOcclusion(
  rect: BrowserSurfaceRect,
  listener: (occluded: boolean) => void,
): () => void {
  let frameId: number | null = null;
  let previous: boolean | null = null;
  const evaluate = () => {
    frameId = null;
    const occluded = isNativeSurfaceOccluded(rect);
    if (occluded === previous) return;
    previous = occluded;
    listener(occluded);
  };
  const schedule = () => {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(evaluate);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  schedule();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    if (frameId !== null) window.cancelAnimationFrame(frameId);
  };
}

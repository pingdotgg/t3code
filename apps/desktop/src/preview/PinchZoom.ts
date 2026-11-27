/** The page's visual viewport: its scale and its offset in layout viewport CSS pixels. */
export interface PageZoom {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const UNZOOMED: PageZoom = { scale: 1, x: 0, y: 0 };

export const MAX_PAGE_ZOOM = 5;
const SNAP_TO_UNZOOMED = 1.01;
const DOM_DELTA_LINE = 1;
const LINE_HEIGHT_PX = 16;
// The page shows a requested zoom only after the main process applies it, so the requested zoom
// stays authoritative while a pinch is under way and the page's own is read once it pauses.
const RESYNC_AFTER_MS = 200;

/** Scales by `factor`, keeping the layout viewport point (`pointX`, `pointY`) still on screen. */
export const zoomPage = (
  current: PageZoom,
  factor: number,
  pointX: number,
  pointY: number,
  layoutWidth: number,
  layoutHeight: number,
): PageZoom => {
  const scale = Math.min(current.scale * factor, MAX_PAGE_ZOOM);
  // Snapping only on the way out lets a slow pinch start from 1.
  if (scale <= 1 || (factor < 1 && scale < SNAP_TO_UNZOOMED)) return UNZOOMED;
  const keep = current.scale / scale;
  const clamp = (offset: number, size: number) =>
    Math.min(Math.max(offset, 0), size - size / scale);
  return {
    scale,
    x: clamp(pointX - (pointX - current.x) * keep, layoutWidth),
    y: clamp(pointY - (pointY - current.y) * keep, layoutHeight),
  };
};

const sameZoom = (a: PageZoom, b: PageZoom) => a.scale === b.scale && a.x === b.x && a.y === b.y;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Pinch extends Point {
  readonly event: WheelEvent;
}

/**
 * Trackpad pinches arrive as ctrlKey wheels. An Electron guest shares the app window's native
 * pinch, so the preload asks for the page's own zoom instead; panning a zoomed page is native.
 */
export const installPinchZoom = (
  target: Window,
  apply: (zoom: PageZoom) => void,
  scheduleFrame: (callback: () => void) => void = (callback) => {
    target.requestAnimationFrame(callback);
  },
  now: () => number = () => target.performance.now(),
) => {
  let zoom = UNZOOMED;
  let requestedAt = Number.NEGATIVE_INFINITY;
  let pinches: Pinch[] = [];
  let frameScheduled = false;

  const flush = () => {
    frameScheduled = false;
    const viewport = target.visualViewport;
    if (!viewport) return;
    if (now() - requestedAt > RESYNC_AFTER_MS) {
      zoom = { scale: viewport.scale, x: viewport.offsetLeft, y: viewport.offsetTop };
    }
    const layoutWidth = viewport.width * viewport.scale;
    const layoutHeight = viewport.height * viewport.scale;
    let next = zoom;
    // Deferred to a frame so page listeners that run after this one can still claim the pinch.
    for (const { event, x, y } of pinches) {
      if (event.defaultPrevented || event.deltaY === 0) continue;
      // Chromium divides wheel deltas by the page's zoom; undo it so each pinch step stays the same size.
      const delta =
        (event.deltaMode === DOM_DELTA_LINE ? event.deltaY * LINE_HEIGHT_PX : event.deltaY) *
        viewport.scale;
      next = zoomPage(next, Math.exp(-delta * 0.01), x, y, layoutWidth, layoutHeight);
    }
    pinches = [];
    if (sameZoom(next, zoom)) return;
    zoom = next;
    requestedAt = now();
    apply(next);
  };

  // Capture, so a page that stops the wheel's propagation without preventing it still zooms.
  const watch = (frame: Window, frameOrigin: () => Point) => {
    frame.addEventListener(
      "wheel",
      (event) => {
        if (!event.isTrusted || !event.ctrlKey) return;
        const origin = frameOrigin();
        pinches.push({ event, x: origin.x + event.clientX, y: origin.y + event.clientY });
        if (frameScheduled) return;
        frameScheduled = true;
        scheduleFrame(flush);
      },
      { capture: true, passive: true },
    );
    // Wheels over a same-origin frame stay in its document, so each one is watched too. Load
    // events stop at the document, never reaching the window.
    frame.document.addEventListener(
      "load",
      (event) => {
        const element = event.target as HTMLIFrameElement | null;
        if (element?.nodeName !== "IFRAME") return;
        let child: Window | null;
        try {
          child = element.contentWindow;
          if (!child?.document) return;
        } catch {
          return;
        }
        watch(child, () => {
          const parent = frameOrigin();
          const rect = element.getBoundingClientRect();
          return {
            x: parent.x + rect.left + element.clientLeft,
            y: parent.y + rect.top + element.clientTop,
          };
        });
      },
      true,
    );
  };
  watch(target, () => ({ x: 0, y: 0 }));

  return {
    reset: () => {
      pinches = [];
      zoom = UNZOOMED;
      requestedAt = now();
      apply(UNZOOMED);
    },
  };
};

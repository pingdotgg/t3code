import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
  type HtmlRenderViewportDelta,
} from "@t3tools/shared/htmlRender";
import { useGT } from "gt-react";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { observeResize } from "~/lib/observeResize";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

type SafariGestureEvent = Event & {
  readonly scale?: number;
  readonly clientX?: number;
  readonly clientY?: number;
};

interface ViewportDelta {
  readonly scale?: number | undefined;
  readonly dx?: number | undefined;
  readonly dy?: number | undefined;
  readonly clientX?: number | undefined;
  readonly clientY?: number | undefined;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

const clampZoom = (value: number): number =>
  Number.isNaN(value) ? 1 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

const stepZoom = (current: number, direction: 1 | -1): number =>
  direction > 0
    ? (ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_ZOOM)
    : ([...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? MIN_ZOOM);

const px = (value: string | undefined): number => parseFloat(value ?? "") || 0;

export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { title } = props.htmlRender;
  const [zoom, setZoom] = useState(1);
  const [announcedZoom, setAnnouncedZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [layout, setLayout] = useState({ baseWidth: HTML_RENDER_COLUMN_WIDTH, padY: 32 });
  const [contentHeight, setContentHeight] = useState<number>();
  const zoomRef = useRef(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const paddingBoxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const lastOuterWidthRef = useRef(0);
  const pendingDeltaRef = useRef<ViewportDelta | null>(null);
  const rafIdRef = useRef(0);
  const pendingAnchorRef = useRef<{
    contentX: number;
    contentY: number;
    targetClientX: number;
    targetClientY: number;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles screen-reader zoom announcements after continuous gestures pause
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncedZoom(zoom), 250);
    return () => clearTimeout(timer);
  }, [zoom]);

  // At 100%, fit viewport.clientWidth so a vertical scrollbar on tall pages never adds horizontal
  // overflow. While zoomed, keep baseWidth stable unless the dialog's outer box resizes.
  const measureLayout = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const outerWidth = viewport.offsetWidth;
    if (zoomRef.current !== 1 && outerWidth === lastOuterWidthRef.current) return;
    lastOuterWidthRef.current = outerWidth;
    const style = paddingBoxRef.current ? getComputedStyle(paddingBoxRef.current) : null;
    const padX = px(style?.paddingLeft) + px(style?.paddingRight);
    const padY = px(style?.paddingTop) + px(style?.paddingBottom);
    const nextWidth = Math.floor(
      (zoomRef.current === 1 ? viewport.clientWidth : outerWidth) - padX,
    );
    if (nextWidth > 0) {
      setLayout((prev) =>
        prev.baseWidth === nextWidth && prev.padY === padY ? prev : { baseWidth: nextWidth, padY },
      );
    }
  };

  const syncLayoutOnZoom = useEffectEvent((nextZoom: number) => {
    if (nextZoom === 1) measureLayout();
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!anchor || !viewport || !canvas) return;
    const vpRect = viewport.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    viewport.scrollLeft +=
      canvasRect.left -
      vpRect.left +
      anchor.contentX * nextZoom -
      (anchor.targetClientX - vpRect.left);
    viewport.scrollTop +=
      canvasRect.top -
      vpRect.top +
      anchor.contentY * nextZoom -
      (anchor.targetClientY - vpRect.top);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores scroll around the zoom anchor after layout commits
  useLayoutEffect(() => {
    syncLayoutOnZoom(zoom);
  }, [zoom]);

  const applyDelta = (delta: ViewportDelta) => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const dx = delta.dx ?? 0;
    const dy = delta.dy ?? 0;
    const current = zoomRef.current;
    const next = delta.scale !== undefined ? clampZoom(current * delta.scale) : current;
    if (next === current) {
      if (dx) viewport.scrollLeft -= dx;
      if (dy) viewport.scrollTop -= dy;
      return;
    }
    const vpRect = viewport.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const targetClientX = delta.clientX ?? vpRect.left + viewport.clientWidth / 2;
    const targetClientY = delta.clientY ?? vpRect.top + viewport.clientHeight / 2;
    pendingAnchorRef.current = {
      contentX: (targetClientX - dx - canvasRect.left) / current,
      contentY: (targetClientY - dy - canvasRect.top) / current,
      targetClientX,
      targetClientY,
    };
    zoomRef.current = next;
    setZoom(next);
  };

  const commitZoom = (targetZoom: number) => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = 0;
    pendingDeltaRef.current = null;
    applyDelta({ scale: clampZoom(targetZoom) / zoomRef.current });
  };

  const queueDelta = (delta: ViewportDelta) => {
    const prev = pendingDeltaRef.current;
    pendingDeltaRef.current = {
      scale: (prev?.scale ?? 1) * (delta.scale ?? 1),
      dx: (prev?.dx ?? 0) + (delta.dx ?? 0),
      dy: (prev?.dy ?? 0) + (delta.dy ?? 0),
      clientX: delta.clientX ?? prev?.clientX,
      clientY: delta.clientY ?? prev?.clientY,
    };
    if (rafIdRef.current === 0) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const pending = pendingDeltaRef.current;
        pendingDeltaRef.current = null;
        if (pending) applyDelta(pending);
      });
    }
  };

  const handleFrameDelta = (delta: HtmlRenderViewportDelta) => {
    const rect =
      delta.x !== undefined && delta.y !== undefined
        ? canvasRef.current?.getBoundingClientRect()
        : undefined;
    queueDelta({
      scale: delta.scale,
      dx: delta.dx,
      dy: delta.dy,
      clientX: rect && delta.x !== undefined ? rect.left + delta.x * zoomRef.current : undefined,
      clientY: rect && delta.y !== undefined ? rect.top + delta.y * zoomRef.current : undefined,
    });
  };

  const attachViewport = (viewport: HTMLDivElement) => {
    viewportRef.current = viewport;
    const ac = new AbortController();
    const listen = { passive: false, signal: ac.signal } as const;
    let touches = 0;
    let gestureScale = 1;
    let prevTouch: { d: number; sx: number; sy: number } | null = null;
    let drag: { id: number; mask: number; x: number; y: number } | null = null;
    const endDrag = () => {
      if (!drag) return;
      if (viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
      drag = null;
      setDragging(false);
    };
    viewport.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey || event.deltaY === 0) return;
        event.preventDefault();
        const d =
          event.deltaY *
          (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
        queueDelta({ scale: Math.exp(-d * 0.01), clientX: event.clientX, clientY: event.clientY });
      },
      listen,
    );
    const onGesture = (event: SafariGestureEvent) => {
      event.preventDefault();
      const scale = event.scale && event.scale > 0 ? event.scale : 1;
      if (event.type === "gesturechange" && touches === 0 && gestureScale > 0) {
        queueDelta({
          scale: scale / gestureScale,
          clientX: typeof event.clientX === "number" ? event.clientX : undefined,
          clientY: typeof event.clientY === "number" ? event.clientY : undefined,
        });
      }
      gestureScale = event.type === "gestureend" ? 1 : scale;
    };
    for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
      viewport.addEventListener(type, onGesture, listen);
    }
    const onTouch = (event: TouchEvent) => {
      touches = event.touches.length;
      if (touches !== 2) {
        prevTouch = null;
        return;
      }
      event.preventDefault();
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      const d = Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY);
      if (d <= 0) return;
      const next = {
        d,
        sx: (a.screenX + b.screenX) / 2,
        sy: (a.screenY + b.screenY) / 2,
      };
      if (prevTouch) {
        queueDelta({
          scale: d / prevTouch.d,
          dx: next.sx - prevTouch.sx,
          dy: next.sy - prevTouch.sy,
          clientX: (a.clientX + b.clientX) / 2,
          clientY: (a.clientY + b.clientY) / 2,
        });
      }
      prevTouch = next;
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      viewport.addEventListener(type, onTouch, listen);
    }
    viewport.addEventListener(
      "pointerdown",
      (event) => {
        if (drag || event.pointerType !== "mouse" || zoomRef.current <= 1) return;
        if (event.button !== 0 && event.button !== 1) return;
        const bounds = viewport.getBoundingClientRect();
        if (
          event.clientX - bounds.left >= viewport.clientWidth ||
          event.clientY - bounds.top >= viewport.clientHeight
        ) {
          return;
        }
        if (event.button === 1) event.preventDefault();
        drag = {
          id: event.pointerId,
          mask: event.button === 1 ? 4 : 1,
          x: event.clientX,
          y: event.clientY,
        };
        viewport.setPointerCapture(event.pointerId);
        setDragging(true);
      },
      { signal: ac.signal },
    );
    viewport.addEventListener(
      "pointermove",
      (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        if ((event.buttons & drag.mask) === 0) return endDrag();
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (dx || dy) queueDelta({ dx, dy });
      },
      { signal: ac.signal },
    );
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      viewport.addEventListener(
        type,
        (event) => {
          if (drag?.id === event.pointerId) endDrag();
        },
        { signal: ac.signal },
      );
    }
    const stopResize = observeResize(viewport, measureLayout);
    measureLayout();
    return () => {
      stopResize();
      ac.abort();
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
      pendingDeltaRef.current = null;
      viewportRef.current = null;
    };
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")) {
      return;
    }
    const next =
      event.key === "+" || event.key === "="
        ? stepZoom(zoomRef.current, 1)
        : event.key === "-"
          ? stepZoom(zoomRef.current, -1)
          : event.key === "0"
            ? 1
            : null;
    if (next === null) return;
    event.preventDefault();
    commitZoom(next);
  };

  const baseHeight = htmlRenderFrameHeight(props.htmlRender, layout.baseWidth, contentHeight);
  const scaledWidth = Math.max(1, Math.round(layout.baseWidth * zoom));
  const scaledHeight = Math.max(1, Math.round(baseHeight * zoom));

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={closeButtonRef}
        onKeyDown={onDialogKeyDown}
      >
        <DialogTitle className="sr-only">{gt("Expanded {title} preview", { title })}</DialogTitle>
        {/* 1144px is the widest the server measures a page; pages are written for the reply column and stretch badly beyond it. */}
        <div className="relative w-[min(92vw,1176px)]">
          <Button
            ref={closeButtonRef}
            aria-label={gt("Close")}
            size="icon-xs"
            variant="media-close"
            className="absolute right-0 -top-10 z-20"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
          <div className="overflow-hidden rounded-lg bg-background shadow-2xl ring-1 ring-border/70">
            <div
              ref={attachViewport}
              tabIndex={0}
              className="max-h-[min(86vh,calc(100vh-160px))] overflow-auto overscroll-contain scrollbar-gutter-both outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
              style={{
                // Keep viewport height stable while zoomed in so short pages can pan vertically
                // without shifting the centered dialog and losing the focal landmark.
                height: zoom > 1 ? baseHeight + layout.padY : undefined,
                touchAction: "pan-x pan-y",
                cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : undefined,
              }}
            >
              <div ref={paddingBoxRef} className="w-fit min-w-full p-2 sm:p-4">
                <div
                  ref={canvasRef}
                  className="relative mx-auto overflow-hidden"
                  style={{ width: scaledWidth, height: scaledHeight }}
                >
                  <div
                    style={{
                      width: layout.baseWidth,
                      height: baseHeight,
                      transform: `scale(${zoom})`,
                      transformOrigin: "0 0",
                    }}
                  >
                    <HtmlRenderDocument
                      src={props.src}
                      title={title}
                      threadRef={props.threadRef}
                      className="block size-full"
                      onContentHeight={setContentHeight}
                      zoomable
                      zoomed={zoom > 1}
                      onViewportDelta={handleFrameDelta}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
            <span className="truncate">{title}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                aria-label={gt("Zoom out")}
                size="icon-sm"
                variant="overlay"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => commitZoom(stepZoom(zoomRef.current, -1))}
              >
                <MinusIcon />
              </Button>
              <Button
                aria-label={gt("Reset zoom")}
                size="sm"
                variant="overlay"
                onClick={() => commitZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                aria-label={gt("Zoom in")}
                size="icon-sm"
                variant="overlay"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => commitZoom(stepZoom(zoomRef.current, 1))}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
          <span className="sr-only" aria-live="polite">
            {gt("{percent}% zoom", { percent: Math.round(announcedZoom * 100) })}
          </span>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

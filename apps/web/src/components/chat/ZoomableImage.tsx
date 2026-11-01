import { useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { flushSync } from "react-dom";

import {
  onWindowControlsOverlayGeometryChange,
  windowControlsOverlayHeight,
} from "../../lib/windowControlsOverlay";

import { AttachmentImage } from "../media/AttachmentImage";

const MAX_ZOOM = 8;

// Subtract the caption strip, matching dialog CSS's --native-titlebar-height.
function readViewerSize() {
  return { width: window.innerWidth, height: window.innerHeight - windowControlsOverlayHeight() };
}

let viewerSize: ReturnType<typeof readViewerSize> | null = null;

// Cached so an unchanged size keeps its identity: a new one resets the zoom.
function getViewerSize() {
  const next = readViewerSize();
  if (next.width !== viewerSize?.width || next.height !== viewerSize.height) viewerSize = next;
  return viewerSize;
}

function subscribeViewerSize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  // Fullscreen caption-strip changes may not emit resize.
  const stopOverlayListener = onWindowControlsOverlayGeometryChange(onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    stopOverlayListener();
  };
}

export interface ZoomableImageHandle {
  pan: (key: string) => boolean;
}

export function ZoomableImage({
  src,
  name,
  mimeType,
  onError,
  ref,
}: {
  src: string;
  name: string;
  mimeType?: string | undefined;
  onError: () => void;
  ref?: Ref<ZoomableImageHandle>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const viewerSize = useSyncExternalStore(subscribeViewerSize, getViewerSize);
  const [zoom, setZoom] = useState(1);
  // A resized viewer refits the image.
  const [zoomViewerSize, setZoomViewerSize] = useState(viewerSize);
  if (zoomViewerSize !== viewerSize) {
    setZoomViewerSize(viewerSize);
    setZoom(1);
  }
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const maxHeight = Math.max(1, Math.min(viewerSize.height * 0.86, viewerSize.height - 160));
  const fit = Math.min(
    1,
    (viewerSize.width * 0.92 - (viewerSize.width >= 640 ? 96 : 0)) / (naturalSize.width || 1),
    maxHeight / (naturalSize.height || 1),
  );
  const width = naturalSize.width * fit * zoom;
  const height = naturalSize.height * fit * zoom;

  useImperativeHandle(
    ref,
    () => ({
      pan(key) {
        const viewport = viewportRef.current;
        if (!viewport || zoom <= 1) return false;
        // A vertical scrollbar alone must not swallow gallery navigation.
        if (
          (key === "ArrowLeft" || key === "ArrowRight") &&
          viewport.scrollWidth <= viewport.offsetWidth
        )
          return false;
        switch (key) {
          case "ArrowLeft":
            viewport.scrollLeft -= 40;
            break;
          case "ArrowRight":
            viewport.scrollLeft += 40;
            break;
          case "ArrowUp":
            viewport.scrollTop -= 40;
            break;
          case "ArrowDown":
            viewport.scrollTop += 40;
            break;
          default:
            return false;
        }
        return true;
      },
    }),
    [zoom],
  );

  const changeZoom = (next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
    if (!viewport || zoom === clamped) return;
    const bounds = viewport.getBoundingClientRect();
    const x = point ? point.x - bounds.left : viewport.clientWidth / 2;
    const y = point ? point.y - bounds.top : viewport.clientHeight / 2;
    const anchorX = (viewport.scrollLeft + x) / zoom;
    const anchorY = (viewport.scrollTop + y) / zoom;
    const clientX = bounds.left + x;
    const clientY = bounds.top + y;
    // The new size must be laid out before the scroll position can keep the anchor in place.
    flushSync(() => setZoom(clamped));
    const resized = viewport.getBoundingClientRect();
    viewport.scrollLeft = anchorX * clamped - (clientX - resized.left);
    viewport.scrollTop = anchorY * clamped - (clientY - resized.top);
  };

  const attachViewport = (viewport: HTMLDivElement) => {
    viewportRef.current = viewport;
    // React's onWheel is passive and cannot stop the page from scrolling.
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoom(zoom * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewportRef.current = null;
    };
  };

  return (
    <div className="min-w-0">
      <div
        ref={attachViewport}
        role="region"
        aria-label={`${name}, zoomable image`}
        aria-description="Click to zoom in or return to fit. Scroll to zoom, drag to pan. Use Enter to toggle zoom, plus or minus to zoom, and 0 to fit."
        tabIndex={0}
        className="max-w-[var(--media-width)] overflow-auto overscroll-contain rounded-lg bg-background shadow-2xl ring-1 ring-border/70 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
        style={{
          width: width || undefined,
          height: height || undefined,
          maxHeight,
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
        }}
        onClick={(event) => {
          // Pointer capture emits a click after dragging; preserve zoom.
          if (suppressClickRef.current || event.detail > 1) return;
          changeZoom(zoom > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!event.repeat) changeZoom(zoom > 1 ? 1 : 2);
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            changeZoom(zoom * 1.5);
          } else if (event.key === "-") {
            event.preventDefault();
            changeZoom(zoom / 1.5);
          } else if (event.key === "0") {
            event.preventDefault();
            changeZoom(1);
          }
        }}
        onPointerDown={(event) => {
          if (dragRef.current) return;
          suppressClickRef.current = false;
          if (event.pointerType !== "mouse" || event.button !== 0 || zoom <= 1) return;
          const viewport = event.currentTarget;
          const bounds = viewport.getBoundingClientRect();
          if (
            event.clientX - bounds.left >= viewport.clientWidth ||
            event.clientY - bounds.top >= viewport.clientHeight
          )
            return;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          viewport.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
            suppressClickRef.current = true;
          }
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <AttachmentImage
          name={name}
          mimeType={mimeType}
          src={src}
          alt={name}
          draggable={false}
          className="block max-w-none select-none"
          style={
            naturalSize.width ? { width, height } : { maxWidth: "var(--media-width)", maxHeight }
          }
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
          onError={onError}
        />
      </div>
      <span className="sr-only" aria-live="polite">
        {Math.round(zoom * 100)}% zoom
      </span>
    </div>
  );
}

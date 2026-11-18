import { useGT } from "gt-react";
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";

import { AttachmentImage } from "../media/AttachmentImage";
import { observeResize } from "~/lib/observeResize";

const MAX_ZOOM = 8;

export interface ZoomableImageHandle {
  pan: (key: string) => boolean;
}

export function ZoomableImage({
  src,
  name,
  mimeType,
  onError,
  onViewportWidthChange,
  ref,
}: {
  src: string;
  name: string;
  mimeType?: string | undefined;
  onError: () => void;
  onViewportWidthChange?: (width: number) => void;
  ref?: Ref<ZoomableImageHandle>;
}) {
  const gt = useGT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 });
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
  const maxHeight = viewerSize.height;
  // A vector scales without loss, and an SVG without width and height reports a tiny default size.
  const fit = Math.min(
    mimeType === "image/svg+xml" ? Infinity : 1,
    viewerSize.width / (naturalSize.width || 1),
    maxHeight / (naturalSize.height || 1),
  );
  const width = naturalSize.width * fit * zoom;
  const height = naturalSize.height * fit * zoom;

  const attachContainer = (container: HTMLDivElement) => {
    // Measure the space left by the real toolbar and caption, including native
    // titlebar padding, wrapped controls and interface font-size changes.
    return observeResize(container, ([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setViewerSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
  };

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
    // Trackpad pinch arrives as a ctrlKey wheel; plain wheels pan through native overflow scrolling.
    // React's onWheel is passive and cannot stop the browser's own page zoom.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoom(zoom * Math.exp(-delta * 0.01), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    const stopObserving = onViewportWidthChange
      ? observeResize(viewport, ([entry]) => {
          if (entry) onViewportWidthChange(entry.contentRect.width);
        })
      : undefined;
    return () => {
      viewport.removeEventListener("wheel", wheel);
      stopObserving?.();
      viewportRef.current = null;
    };
  };

  return (
    <div
      ref={attachContainer}
      className="flex size-full min-h-0 min-w-0 items-center justify-center"
    >
      <div
        ref={attachViewport}
        role="region"
        aria-label={gt("{name}, zoomable image", { name })}
        aria-description={gt(
          "Click to zoom in or return to fit. Pinch or Ctrl+scroll to zoom, scroll or drag to pan. Use Enter to toggle zoom, plus or minus to zoom, and 0 to fit.",
        )}
        tabIndex={0}
        className="max-w-full overscroll-contain rounded-lg bg-background shadow-2xl ring-1 ring-border/70 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
        style={{
          width: width || undefined,
          height: height || undefined,
          maxHeight,
          // A wheel at fit must not latch native scrolling that starts after zoom.
          overflow: zoom > 1 ? "auto" : "hidden",
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
        {gt("{percent}% zoom", { percent: Math.round(zoom * 100) })}
      </span>
    </div>
  );
}

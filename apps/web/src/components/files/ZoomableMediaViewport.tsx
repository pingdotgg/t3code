import { FileZoomControls, FILE_ZOOM_TOOLBAR_CLASS } from "./FileZoomControls";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "~/lib/observeResize";
import { usePinchZoom } from "./pinchZoom";

export function ZoomableMediaViewport({
  children,
  maxZoom = 5,
  minZoom = 1,
  label = "Video preview",
  layout = "media",
}: {
  children: ReactNode;
  maxZoom?: number;
  minZoom?: number;
  label?: string;
  layout?: "media" | "table";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const anchor = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    scale: number;
    targets?: { node: HTMLElement; left: number; top: number; x: number; y: number }[] | undefined;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the viewport so video keeps its fit size while its content is magnified.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => setSize({ width: root.clientWidth, height: root.clientHeight });
    measure();
    return observeResize(root, measure);
  }, []);
  usePinchZoom(ref, (factor, point) => {
    const root = ref.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const targets =
      layout === "table"
        ? [...root.querySelectorAll<HTMLElement>("[data-zoom-scroll]")].map((node) => {
            const bounds = node.getBoundingClientRect();
            return {
              node,
              left: node.scrollLeft,
              top: node.scrollTop,
              x: rect.left + point.x - bounds.left,
              y: rect.top + point.y - bounds.top,
            };
          })
        : undefined;
    anchor.current = { ...point, left: root.scrollLeft, top: root.scrollTop, scale: zoom, targets };
    setZoom(Math.min(maxZoom, Math.max(minZoom, zoom * factor)));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the media point beneath the pointer after the new scaled bounds commit.
  useLayoutEffect(() => {
    const point = anchor.current;
    anchor.current = null;
    if (!point || !ref.current) return;
    if (point.targets) {
      for (const target of point.targets)
        target.node.scrollTo({
          left: target.left + target.x / point.scale - target.x / zoom,
          top: target.top + target.y / point.scale - target.y / zoom,
        });
      return;
    }
    ref.current.scrollTo({
      left: ((point.left + point.x) * zoom) / point.scale - point.x,
      top: ((point.top + point.y) * zoom) / point.scale - point.y,
    });
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={FILE_ZOOM_TOOLBAR_CLASS}>
        <span className="mr-auto" />
        <FileZoomControls
          zoom={zoom}
          min={minZoom}
          max={maxZoom}
          onChange={setZoom}
          onReset={() => setZoom(1)}
        />
      </div>
      <div
        ref={ref}
        role="region"
        aria-label={label}
        className={`relative min-h-0 min-w-0 flex-1 ${layout === "table" ? "overflow-clip contain-strict" : "overflow-auto"}`}
      >
        {layout === "table" ? (
          <div
            className="absolute top-0 left-0 flex"
            style={{
              width: size.width / zoom,
              height: size.height / zoom,
              transform: `scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {children}
          </div>
        ) : (
          <div className="flex min-h-full min-w-full items-center justify-center">
            <div style={{ width: size.width * zoom, height: size.height * zoom }}>
              <div
                className="flex items-center justify-center"
                style={{
                  width: size.width,
                  height: size.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                {children}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

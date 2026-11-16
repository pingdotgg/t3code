import { FileZoomControls, FILE_ZOOM_TOOLBAR_CLASS } from "./FileZoomControls";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "~/lib/observeResize";
import { usePinchZoom } from "./pinchZoom";

export function ZoomableMediaViewport({
  children,
  maxZoom = 5,
  minZoom = 1,
  label = "Video zoom",
}: {
  children: ReactNode;
  maxZoom?: number;
  minZoom?: number;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const anchor = useRef<{ x: number; y: number; left: number; top: number; scale: number } | null>(
    null,
  );
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
    anchor.current = { ...point, left: root.scrollLeft, top: root.scrollTop, scale: zoom };
    setZoom(Math.min(maxZoom, Math.max(minZoom, zoom * factor)));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the media point beneath the pointer after the new scaled bounds commit.
  useLayoutEffect(() => {
    const point = anchor.current;
    anchor.current = null;
    if (!point || !ref.current) return;
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
          sliderLabel={label}
        />
      </div>
      <div ref={ref} className="min-h-0 min-w-0 flex-1 overflow-auto">
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
      </div>
    </div>
  );
}

import { Minus, Plus, Scan } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { INITIAL_VIEW, fitToContent, panBy, zoomAt, type Rect, type View } from "./viewport";

const GRID_SPACING = 22;
const BUTTON_ZOOM_STEP = 1.2;
const WHEEL_ZOOM_RATE = 0.01;

const ViewScaleContext = createContext(1);

/** The canvas zoom, so a child that drags converts screen pixels to canvas pixels. */
export const useViewScale = () => useContext(ViewScaleContext);

const zoomButton = "grid h-[30px] w-8 place-items-center text-muted hover:bg-hover hover:text-fg";

export function Viewport({ content, children }: { content?: Rect; children?: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startY: number; origin: View } | null>(null);
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [panning, setPanning] = useState(false);

  // React registers wheel listeners as passive, which forbids preventDefault.
  const attachSurface = useCallback((surface: HTMLDivElement) => {
    surfaceRef.current = surface;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      setView((current) =>
        event.ctrlKey || event.metaKey
          ? zoomAt(
              current,
              current.k * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE),
              event.clientX - rect.left,
              event.clientY - rect.top,
            )
          : panBy(current, -event.deltaX, -event.deltaY),
      );
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surfaceRef.current = null;
    };
  }, []);

  const zoomAroundCenter = (factor: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView((current) => zoomAt(current, current.k * factor, rect.width / 2, rect.height / 2));
  };

  const fit = () => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (rect) setView(fitToContent(content ?? null, rect));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { startX: event.clientX, startY: event.clientY, origin: view };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active) return;
    setView(panBy(active.origin, event.clientX - active.startX, event.clientY - active.startY));
  };

  const endPan = () => {
    drag.current = null;
    setPanning(false);
  };

  const spacing = GRID_SPACING * view.k;
  return (
    <div className="relative h-full overflow-hidden">
      <div
        ref={attachSurface}
        data-testid="board-canvas"
        className={`absolute inset-0 touch-none ${panning ? "cursor-grabbing" : "cursor-grab"}`}
        style={{
          backgroundImage: "radial-gradient(circle, var(--color-dot) 1.3px, transparent 1.5px)",
          backgroundSize: `${spacing}px ${spacing}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <ViewScaleContext.Provider value={view.k}>{children}</ViewScaleContext.Provider>
        </div>
      </div>
      <div className="absolute top-3.5 right-3.5 flex flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-panel">
        <button
          type="button"
          aria-label="Zoom in"
          className={zoomButton}
          onClick={() => zoomAroundCenter(BUTTON_ZOOM_STEP)}
        >
          <Plus className="size-4" />
        </button>
        <div
          data-testid="zoom-label"
          className="border-y border-line py-[3px] text-center text-[10px] text-faint"
        >
          {Math.round(view.k * 100)}%
        </div>
        <button
          type="button"
          aria-label="Zoom out"
          className={zoomButton}
          onClick={() => zoomAroundCenter(1 / BUTTON_ZOOM_STEP)}
        >
          <Minus className="size-4" />
        </button>
        <button type="button" aria-label="Fit to content" className={zoomButton} onClick={fit}>
          <Scan className="size-4" />
        </button>
      </div>
    </div>
  );
}

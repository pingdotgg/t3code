import * as Schema from "effect/Schema";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:voice-panel-geometry:v1";
const VIEWPORT_MARGIN = 12;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 340;
const DEFAULT_WIDTH = 384;
const DEFAULT_HEIGHT = 460;

const PanelGeometrySchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export interface VoicePanelGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

function viewportSize(): { readonly width: number; readonly height: number } {
  return {
    width: typeof window === "undefined" ? 1_280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  };
}

export function clampVoicePanelGeometry(
  geometry: VoicePanelGeometry,
  viewport = viewportSize(),
): VoicePanelGeometry {
  const maxWidth = Math.max(MIN_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(MIN_HEIGHT, viewport.height - VIEWPORT_MARGIN * 2);
  const width = Math.min(maxWidth, Math.max(MIN_WIDTH, geometry.width));
  const height = Math.min(maxHeight, Math.max(MIN_HEIGHT, geometry.height));
  return {
    x: Math.min(viewport.width - width - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, geometry.x)),
    y: Math.min(viewport.height - height - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, geometry.y)),
    width,
    height,
  };
}

function defaultGeometry(): VoicePanelGeometry {
  const viewport = viewportSize();
  const width = Math.min(DEFAULT_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  const height = Math.min(DEFAULT_HEIGHT, viewport.height - VIEWPORT_MARGIN * 2);
  return clampVoicePanelGeometry({
    x: viewport.width - width - VIEWPORT_MARGIN,
    y: viewport.height - height - VIEWPORT_MARGIN,
    width,
    height,
  });
}

interface PointerOperation {
  readonly pointerId: number;
  readonly target: HTMLElement;
  readonly mode: "move" | "resize";
  readonly edge?: ResizeEdge;
  readonly startX: number;
  readonly startY: number;
  readonly startGeometry: VoicePanelGeometry;
  pending: VoicePanelGeometry;
  rafId: number | null;
}

export function useVoicePanelGeometry(): {
  readonly style: CSSProperties;
  readonly moveHandlers: {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  readonly resizeHandlers: (edge: ResizeEdge) => {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
} {
  const [geometry, setGeometry] = useState<VoicePanelGeometry>(() => {
    try {
      const stored = getLocalStorageItem(STORAGE_KEY, PanelGeometrySchema);
      return stored ? clampVoicePanelGeometry(stored) : defaultGeometry();
    } catch (error) {
      console.error("Could not read voice panel geometry.", error);
      return defaultGeometry();
    }
  });
  const operationRef = useRef<PointerOperation | null>(null);

  const release = useCallback((pointerId: number, persist: boolean) => {
    const operation = operationRef.current;
    if (!operation || operation.pointerId !== pointerId) return;
    if (operation.rafId !== null) cancelAnimationFrame(operation.rafId);
    try {
      if (operation.target.hasPointerCapture(pointerId)) {
        operation.target.releasePointerCapture(pointerId);
      }
    } catch {
      // Chromium may release capture before pointercancel reaches React.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    const finalGeometry = persist ? operation.pending : operation.startGeometry;
    operationRef.current = null;
    setGeometry(finalGeometry);
    if (persist) {
      try {
        setLocalStorageItem(STORAGE_KEY, finalGeometry, PanelGeometrySchema);
      } catch (error) {
        console.error("Could not persist voice panel geometry.", error);
      }
    }
  }, []);

  const schedule = useCallback((next: VoicePanelGeometry) => {
    const operation = operationRef.current;
    if (!operation) return;
    operation.pending = clampVoicePanelGeometry(next);
    if (operation.rafId !== null) return;
    operation.rafId = requestAnimationFrame(() => {
      const active = operationRef.current;
      if (!active) return;
      active.rafId = null;
      setGeometry(active.pending);
    });
  }, []);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: PointerOperation["mode"], edge?: ResizeEdge) => {
      if (event.button !== 0 || operationRef.current) return;
      if (mode === "move" && (event.target as Element).closest("button")) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const cursor = mode === "move" ? "grabbing" : `${edge}-resize`;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";
      operationRef.current = {
        pointerId: event.pointerId,
        target,
        mode,
        ...(edge === undefined ? {} : { edge }),
        startX: event.clientX,
        startY: event.clientY,
        startGeometry: geometry,
        pending: geometry,
        rafId: null,
      };
    },
    [geometry],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const operation = operationRef.current;
      if (!operation || operation.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - operation.startX;
      const dy = event.clientY - operation.startY;
      if (operation.mode === "move") {
        schedule({
          ...operation.startGeometry,
          x: operation.startGeometry.x + dx,
          y: operation.startGeometry.y + dy,
        });
        return;
      }

      const edge = operation.edge ?? "se";
      let { x, y, width, height } = operation.startGeometry;
      if (edge.includes("e")) width += dx;
      if (edge.includes("s")) height += dy;
      if (edge.includes("w")) {
        x += dx;
        width -= dx;
      }
      if (edge.includes("n")) {
        y += dy;
        height -= dy;
      }
      if (width < MIN_WIDTH) {
        if (edge.includes("w")) x -= MIN_WIDTH - width;
        width = MIN_WIDTH;
      }
      if (height < MIN_HEIGHT) {
        if (edge.includes("n")) y -= MIN_HEIGHT - height;
        height = MIN_HEIGHT;
      }
      schedule({ x, y, width, height });
    },
    [schedule],
  );

  const commonHandlers = useMemo(
    () => ({
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => release(event.pointerId, true),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => release(event.pointerId, false),
    }),
    [onPointerMove, release],
  );

  useEffect(() => {
    const onResize = () => setGeometry((current) => clampVoicePanelGeometry(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return {
    style: { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height },
    moveHandlers: {
      onPointerDown: (event) => begin(event, "move"),
      ...commonHandlers,
    },
    resizeHandlers: (edge) => ({
      onPointerDown: (event) => begin(event, "resize", edge),
      ...commonHandlers,
    }),
  };
}

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { RotateCcwIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";

import { remapMermaidSvgIds } from "~/lib/mermaidRendering";
import {
  fitMermaidViewport,
  MAX_MERMAID_OVERLAY_ZOOM,
  mermaidSvgContentSize,
  MERMAID_OVERLAY_ZOOM_STEP,
  MIN_MERMAID_OVERLAY_ZOOM,
  panMermaidViewport,
  resetMermaidViewport,
  zoomMermaidViewportAtPoint,
  type MermaidViewport,
} from "~/lib/mermaidViewport";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const WHEEL_ZOOM_SENSITIVITY = 0.0015;

interface MermaidOverlayProps {
  readonly open: boolean;
  readonly svg: string;
  readonly title: string;
  readonly onOpenChange: (open: boolean) => void;
}

function scenePoint(
  scene: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = scene.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function measuredSvgSize(
  scene: HTMLElement,
  zoom: number,
): { width: number; height: number } | null {
  const svg = scene.querySelector("svg");
  if (!(svg instanceof SVGElement) || zoom === 0) return null;
  const rect = svg.getBoundingClientRect();
  const width = rect.width / zoom;
  const height = rect.height / zoom;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function MermaidOverlay({ open, svg, title, onOpenChange }: MermaidOverlayProps) {
  const overlayDomId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<MermaidViewport>(resetMermaidViewport());
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const userAdjustedRef = useRef(false);
  const [sceneEl, setSceneEl] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<MermaidViewport>(resetMermaidViewport);
  const [panning, setPanning] = useState(false);

  const overlaySvg = useMemo(
    () => remapMermaidSvgIds(svg, `-${overlayDomId}`),
    [overlayDomId, svg],
  );
  const contentSize = useMemo(() => mermaidSvgContentSize(svg), [svg]);

  const setSceneNode = (node: HTMLDivElement | null) => {
    sceneRef.current = node;
    setSceneEl((current) => (current === node ? current : node));
  };

  const commitViewport = (next: MermaidViewport, userAdjusted: boolean) => {
    if (userAdjusted) userAdjustedRef.current = true;
    viewportRef.current = next;
    setViewport(next);
  };

  const fitToScene = (scene: HTMLElement) => {
    if (scene.clientWidth <= 0 || scene.clientHeight <= 0) return;
    const size = contentSize ?? measuredSvgSize(scene, viewportRef.current.zoom);
    if (!size) return;
    userAdjustedRef.current = false;
    commitViewport(
      fitMermaidViewport({ width: scene.clientWidth, height: scene.clientHeight }, size),
      false,
    );
  };

  useLayoutEffect(() => {
    if (!open) {
      userAdjustedRef.current = false;
      pointerRef.current = null;
      commitViewport(resetMermaidViewport(), false);
      return;
    }
    if (sceneEl) fitToScene(sceneEl);
  }, [open, svg, sceneEl, contentSize]);

  useEffect(() => {
    if (!open || sceneEl == null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!userAdjustedRef.current) fitToScene(sceneEl);
    });
    observer.observe(sceneEl);
    return () => observer.disconnect();
  }, [open, svg, sceneEl, contentSize]);

  useEffect(() => {
    if (!open || sceneEl == null) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      commitViewport(
        zoomMermaidViewportAtPoint(
          viewportRef.current,
          viewportRef.current.zoom * factor,
          scenePoint(sceneEl, event.clientX, event.clientY),
        ),
        true,
      );
    };

    sceneEl.addEventListener("wheel", onWheel, { passive: false });
    return () => sceneEl.removeEventListener("wheel", onWheel);
  }, [open, sceneEl]);

  const zoomByStep = (direction: 1 | -1) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = scene.getBoundingClientRect();
    const step = direction === 1 ? MERMAID_OVERLAY_ZOOM_STEP : 1 / MERMAID_OVERLAY_ZOOM_STEP;
    commitViewport(
      zoomMermaidViewportAtPoint(viewportRef.current, viewportRef.current.zoom * step, {
        x: rect.width / 2,
        y: rect.height / 2,
      }),
      true,
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    setPanning(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const last = pointerRef.current;
    if (last == null) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    commitViewport(panMermaidViewport(viewportRef.current, dx, dy), true);
  };

  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current == null) return;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanning(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomByStep(1);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomByStep(-1);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      if (sceneRef.current) fitToScene(sceneRef.current);
    }
  };

  const zoomPercent = Math.round(viewport.zoom * 100);
  const zoomInDisabled = viewport.zoom >= MAX_MERMAID_OVERLAY_ZOOM;
  const zoomOutDisabled = viewport.zoom <= MIN_MERMAID_OVERLAY_ZOOM;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="h-[min(92vh,64rem)] max-w-[min(96vw,90rem)] gap-0 overflow-hidden p-0"
        onKeyDown={onKeyDown}
        data-mermaid-overlay=""
      >
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              Scroll to zoom, drag to pan. Press Escape to close.
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-label="Zoom out"
                    data-mermaid-overlay-zoom-out=""
                    disabled={zoomOutDisabled}
                    onClick={() => zoomByStep(-1)}
                  />
                }
              >
                <ZoomOutIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Zoom out</TooltipPopup>
            </Tooltip>
            <span
              className="min-w-12 px-1 text-center text-xs text-muted-foreground tabular-nums"
              data-mermaid-overlay-zoom=""
            >
              {zoomPercent}%
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-label="Zoom in"
                    data-mermaid-overlay-zoom-in=""
                    disabled={zoomInDisabled}
                    onClick={() => zoomByStep(1)}
                  />
                }
              >
                <ZoomInIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Zoom in</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-label="Reset view"
                    data-mermaid-overlay-reset=""
                    onClick={() => {
                      if (sceneRef.current) fitToScene(sceneRef.current);
                    }}
                  />
                }
              >
                <RotateCcwIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Reset view</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-label="Close"
                    onClick={() => onOpenChange(false)}
                  />
                }
              >
                <XIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Close</TooltipPopup>
            </Tooltip>
          </div>
        </DialogHeader>
        <div
          ref={setSceneNode}
          className="chat-markdown-mermaid-overlay-scene"
          data-mermaid-overlay-scene=""
          data-panning={panning ? "true" : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onLostPointerCapture={endPan}
        >
          <div
            className="chat-markdown-mermaid-overlay-canvas"
            style={{
              width: contentSize?.width,
              height: contentSize?.height,
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
              willChange: panning ? "transform" : undefined,
            }}
            dangerouslySetInnerHTML={{ __html: overlaySvg }}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}

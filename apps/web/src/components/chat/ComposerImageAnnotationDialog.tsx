import {
  addStrokePoint,
  openStrokePath,
  startStroke,
  strokeBounds,
  type StrokeGeometry,
} from "~/lib/annotationStroke";
import type { PreviewAnnotationRect } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { EraserIcon, PencilIcon, Undo2Icon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { createCanvas, readImageColorSpace } from "../../lib/imageCanvas";
import { encodeCanvas } from "../../lib/imageCompression";
import { cn, isMacPlatform } from "~/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { composerFloatingLayerProps } from "./composerEventScope";

type AnnotationTool = "draw" | "erase";

interface DrawnStroke {
  readonly id: number;
  readonly color: string;
  readonly width: number;
  readonly path: string;
  readonly bounds: PreviewAnnotationRect;
}

interface ActiveStroke {
  readonly pointerId: number;
  readonly color: string;
  readonly width: number;
  readonly geometry: StrokeGeometry;
  readonly closedPaths: string[];
  readonly group: SVGGElement;
  path: SVGPathElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// The browser panel's Draw tool paints 4 CSS pixels wide in its theme's primary color.
const STROKE_SCREEN_WIDTH = 4;
const PRIMARY_COLOR = "var(--primary)";
const STROKE_COLORS = [PRIMARY_COLOR, "#ef4444", "#f59e0b", "#22c55e", "#ffffff", "#000000"];

function resolveColor(color: string): string {
  if (color !== PRIMARY_COLOR) return color;
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#2563eb"
  );
}

function annotatedFileName(name: string, mimeType: string): string {
  if (mimeType !== "image/png") return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.png`;
}

/** Paints the strokes over the original pixels; `null` when the browser cannot draw or encode it. */
async function flattenAnnotatedImage(
  image: ComposerImageAttachment,
  strokes: ReadonlyArray<DrawnStroke>,
  viewSize: { width: number; height: number },
): Promise<File | null> {
  const bitmap = await createImageBitmap(image.file, { imageOrientation: "from-image" }).catch(
    () => null,
  );
  if (!bitmap) return null;
  try {
    const colorSpace = await readImageColorSpace(image.file);
    const surface = createCanvas(bitmap.width, bitmap.height, colorSpace);
    if (!surface) return null;
    const { context } = surface;
    context.drawImage(bitmap, 0, 0);
    context.scale(bitmap.width / viewSize.width, bitmap.height / viewSize.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      context.strokeStyle = stroke.color;
      context.lineWidth = stroke.width;
      context.stroke(new Path2D(stroke.path));
    }
    const mimeType =
      image.mimeType === "image/jpeg" || image.mimeType === "image/webp"
        ? image.mimeType
        : "image/png";
    const blob = await encodeCanvas(surface.canvas, colorSpace, 0.92, mimeType);
    if (!blob) return null;
    return new File([blob], annotatedFileName(image.name, mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

export function ComposerImageAnnotationDialog({
  image,
  onCancel,
  onSave,
}: {
  readonly image: ComposerImageAttachment;
  readonly onCancel: () => void;
  /** Resolves once the edited image is stored; `false` keeps the dialog open. */
  readonly onSave: (file: File) => Promise<boolean>;
}) {
  const gt = useGT();
  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("draw");
  const [color, setColor] = useState(PRIMARY_COLOR);
  const [strokes, setStrokes] = useState<ReadonlyArray<DrawnStroke>>([]);
  const [history, setHistory] = useState<ReadonlyArray<ReadonlyArray<DrawnStroke>>>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const liveLayerRef = useRef<SVGGElement>(null);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const nextStrokeIdRef = useRef(0);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  const close = () => {
    flushSync(onCancel);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };

  const commit = (next: ReadonlyArray<DrawnStroke>) => {
    setHistory((current) => [...current, strokes]);
    setStrokes(next);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setStrokes(previous);
  };

  const done = async () => {
    if (saving || activeStrokeRef.current) return;
    if (strokes.length === 0 || !viewSize) {
      close();
      return;
    }
    setSaving(true);
    setFailed(false);
    const file = await flattenAnnotatedImage(image, strokes, viewSize).catch(() => null);
    const saved = file ? await onSave(file).catch(() => false) : false;
    if (saved) {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      return;
    }
    setSaving(false);
    setFailed(true);
  };

  const toViewPoint = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = viewSize ? viewSize.width / rect.width : 1;
    return {
      x: Math.round((event.clientX - rect.left) * scale * 10) / 10,
      y: Math.round((event.clientY - rect.top) * scale * 10) / 10,
      scale,
    };
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || saving || activeStrokeRef.current) return;
    event.preventDefault();
    const { x, y, scale } = toViewPoint(event);
    if (tool === "erase") {
      const index = strokes.findLastIndex(
        (stroke) =>
          x >= stroke.bounds.x &&
          x <= stroke.bounds.x + stroke.bounds.width &&
          y >= stroke.bounds.y &&
          y <= stroke.bounds.y + stroke.bounds.height,
      );
      if (index >= 0) commit(strokes.filter((_, candidate) => candidate !== index));
      return;
    }
    const layer = liveLayerRef.current;
    if (!layer) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const strokeColor = resolveColor(color);
    const width = STROKE_SCREEN_WIDTH * scale;
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("stroke", strokeColor);
    group.setAttribute("stroke-width", String(width));
    const path = group.appendChild(document.createElementNS(SVG_NS, "path"));
    layer.appendChild(group);
    activeStrokeRef.current = {
      pointerId: event.pointerId,
      color: strokeColor,
      width,
      geometry: startStroke({ x, y }),
      closedPaths: [],
      group,
      path,
    };
  };

  // Strokes paint straight into the SVG on pointer input, so drawing never re-renders React.
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const { x, y } = toViewPoint(event);
    const closedPath = addStrokePoint(active.geometry, { x, y });
    if (closedPath) {
      active.path.setAttribute("d", closedPath);
      active.closedPaths.push(closedPath);
      active.path = active.group.appendChild(document.createElementNS(SVG_NS, "path"));
    }
    active.path.setAttribute("d", openStrokePath(active.geometry));
  };

  const finishStroke = (event: PointerEvent<SVGSVGElement>) => {
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    activeStrokeRef.current = null;
    active.group.remove();
    if (active.geometry.points.length < 2) return;
    nextStrokeIdRef.current += 1;
    commit([
      ...strokes,
      {
        id: nextStrokeIdRef.current,
        color: active.color,
        width: active.width,
        path: [...active.closedPaths, openStrokePath(active.geometry)].join(" "),
        bounds: strokeBounds(active.geometry, active.width),
      },
    ]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (!saving) undo();
      return;
    }
    // Enter on a focused toolbar button presses that button instead.
    if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void done();
      return;
    }
    if (mod || event.altKey) return;
    if (event.key === "d") setTool("draw");
    else if (event.key === "e") setTool("erase");
  };

  const colorLabels: Record<string, string> = {
    [PRIMARY_COLOR]: gt("Theme color"),
    "#ef4444": gt("Red", { $context: "stroke color" }),
    "#f59e0b": gt("Orange", { $context: "stroke color" }),
    "#22c55e": gt("Green", { $context: "stroke color" }),
    "#ffffff": gt("White", { $context: "stroke color" }),
    "#000000": gt("Black", { $context: "stroke color" }),
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) close();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        mediaControlsPlacement="inside"
        solidBackdrop
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] flex-col items-center justify-center overflow-visible [--media-width:92vw] [--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.78),calc(100vh-var(--native-titlebar-height,0px)-200px))]"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">{gt("Draw on {name}", { name: image.name })}</DialogTitle>
        <div className="flex max-h-full max-w-full flex-col items-center gap-3">
          <div className="flex max-w-full flex-wrap items-center justify-center gap-1 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl">
            <ToggleGroup
              variant="default"
              size="sm"
              aria-label={gt("Drawing tool")}
              value={[tool]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "draw" || next === "erase") setTool(next);
              }}
            >
              <ToggleGroupItem value="draw" aria-label={gt("Draw freehand (D)")}>
                <PencilIcon />
                {gt("Draw", { $context: "drawing tool, freehand pen" })}
              </ToggleGroupItem>
              <ToggleGroupItem value="erase" aria-label={gt("Erase a stroke (E)")}>
                <EraserIcon />
                {gt("Erase", { $context: "drawing tool, removes a stroke" })}
              </ToggleGroupItem>
            </ToggleGroup>
            <div
              role="radiogroup"
              aria-label={gt("Stroke color")}
              className="flex items-center px-1"
            >
              {STROKE_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  role="radio"
                  aria-checked={color === swatch}
                  aria-label={colorLabels[swatch]}
                  onClick={() => {
                    setColor(swatch);
                    setTool("draw");
                  }}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    color === swatch && "bg-accent",
                  )}
                >
                  <span
                    className="size-4 rounded-full ring-1 ring-foreground/20 ring-inset"
                    style={{ background: swatch }}
                  />
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={undo}
              disabled={history.length === 0 || saving}
              aria-label={gt("Undo")}
            >
              <Undo2Icon />
              {gt("Undo")}
            </Button>
            <Button variant="ghost" size="sm" onClick={close} disabled={saving}>
              {gt("Cancel")}
            </Button>
            <Button size="sm" onClick={() => void done()} disabled={saving}>
              {gt("Done")}
            </Button>
          </div>
          <div className="relative overflow-hidden rounded-lg border border-border/70 shadow-2xl">
            <img
              src={image.previewUrl}
              alt={image.name}
              draggable={false}
              onLoad={(event) =>
                setViewSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              className="block max-h-[var(--media-height)] max-w-[var(--media-width)] select-none"
            />
            {viewSize ? (
              <svg
                viewBox={`0 0 ${viewSize.width} ${viewSize.height}`}
                preserveAspectRatio="none"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn(
                  "absolute inset-0 size-full touch-none",
                  tool === "draw" ? "cursor-crosshair" : "cursor-pointer",
                )}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finishStroke}
                onPointerCancel={finishStroke}
              >
                {strokes.map((stroke) => (
                  <path
                    key={stroke.id}
                    d={stroke.path}
                    stroke={stroke.color}
                    strokeWidth={stroke.width}
                  />
                ))}
                <g ref={liveLayerRef} />
              </svg>
            ) : null}
          </div>
          {failed ? (
            <p role="alert" className="text-xs text-white/80">
              {gt("The drawing could not be saved. Try again or cancel.")}
            </p>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

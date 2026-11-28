import {
  addStrokePoint,
  openStrokePath,
  startStroke,
  type StrokeGeometry,
} from "~/lib/annotationStroke";
import { useGT } from "gt-react";
import { EraserIcon, PencilIcon, Undo2Icon } from "lucide-react";
import { use, useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";

import { createCanvas, readImageColorSpace } from "../../lib/imageCanvas";
import { encodeCanvas } from "../../lib/imageCompression";
import { cn, isMacPlatform } from "~/lib/utils";
import { Button } from "../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { ZoomableImageNaturalSize } from "./ZoomableImage";

type AnnotationTool = "draw" | "erase";

/** The stored result of an edit: the new bytes and a URL that shows them. */
export interface EditedImage {
  readonly src: string;
  readonly file: File;
}

export interface ImageAnnotationTarget {
  readonly file: File;
  readonly name: string;
  readonly mimeType: string;
  /** Stores the flattened file; `null` when it could not be stored. */
  readonly save: (file: File) => Promise<EditedImage | null>;
}

export interface ImageAnnotationStatus {
  readonly dirty: boolean;
  readonly saving: boolean;
}

interface DrawnStroke {
  readonly id: number;
  readonly color: string;
  readonly width: number;
  readonly path: string;
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
const ERASER_SCREEN_WIDTH = 16;
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
  target: ImageAnnotationTarget,
  strokes: ReadonlyArray<DrawnStroke>,
  viewSize: { width: number; height: number },
): Promise<File | null> {
  const bitmap = await createImageBitmap(target.file, { imageOrientation: "from-image" }).catch(
    () => null,
  );
  if (!bitmap) return null;
  try {
    const colorSpace = await readImageColorSpace(target.file);
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
      target.mimeType === "image/jpeg" || target.mimeType === "image/webp"
        ? target.mimeType
        : "image/png";
    const blob = await encodeCanvas(surface.canvas, colorSpace, 0.92, mimeType);
    if (!blob) return null;
    return new File([blob], annotatedFileName(target.name, mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Draws over an image in place: the surface covers the image exactly and the toolbar floats
 * above it, so nothing around the image moves while editing.
 */
export function ImageAnnotationOverlay({
  target,
  onStatusChange,
  onSaved,
  onExit,
}: {
  readonly target: ImageAnnotationTarget;
  readonly onStatusChange: (status: ImageAnnotationStatus) => void;
  readonly onSaved: (edited: EditedImage) => void;
  /** Leaves edit mode without changing the image. */
  readonly onExit: () => void;
}) {
  const gt = useGT();
  const naturalSize = use(ZoomableImageNaturalSize);
  const [tool, setTool] = useState<AnnotationTool>("draw");
  const [color, setColor] = useState(PRIMARY_COLOR);
  const [strokes, setStrokes] = useState<ReadonlyArray<DrawnStroke>>([]);
  const [history, setHistory] = useState<ReadonlyArray<ReadonlyArray<DrawnStroke>>>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const liveLayerRef = useRef<SVGGElement>(null);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const nextStrokeIdRef = useRef(0);
  const doneButtonRef = useRef<HTMLButtonElement>(null);

  const showStrokes = (next: ReadonlyArray<DrawnStroke>) => {
    setStrokes(next);
    onStatusChange({ dirty: next.length > 0, saving });
  };

  const commit = (next: ReadonlyArray<DrawnStroke>) => {
    setHistory((current) => [...current, strokes]);
    showStrokes(next);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous || saving) return;
    setHistory(history.slice(0, -1));
    showStrokes(previous);
  };

  const done = async () => {
    if (saving || activeStrokeRef.current) return;
    if (strokes.length === 0) {
      onExit();
      return;
    }
    setSaving(true);
    setFailed(false);
    onStatusChange({ dirty: true, saving: true });
    const file = await flattenAnnotatedImage(target, strokes, naturalSize).catch(() => null);
    const edited = file ? await target.save(file).catch(() => null) : null;
    if (edited) {
      onSaved(edited);
      return;
    }
    setSaving(false);
    setFailed(true);
    onStatusChange({ dirty: true, saving: false });
  };

  const handleKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    // Enter on a focused button presses that button instead.
    if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void done();
      return;
    }
    if (mod || event.altKey || event.target instanceof HTMLInputElement) return;
    if (event.key === "d") setTool("draw");
    else if (event.key === "e") setTool("erase");
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for drawing keys anywhere in the preview and moves focus to Done so Enter saves
  useEffect(() => {
    doneButtonRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: globalThis.KeyboardEvent) => handleKey(event);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const toViewPoint = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = naturalSize.width / rect.width;
    return {
      x: Math.round((event.clientX - rect.left) * scale * 10) / 10,
      y: Math.round((event.clientY - rect.top) * scale * 10) / 10,
      scale,
    };
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || saving || activeStrokeRef.current) return;
    event.preventDefault();
    if (tool === "erase") {
      const strokeId =
        event.target instanceof SVGPathElement ? event.target.dataset.strokeId : undefined;
      if (strokeId !== undefined)
        commit(strokes.filter((stroke) => String(stroke.id) !== strokeId));
      return;
    }
    const layer = liveLayerRef.current;
    if (!layer) return;
    const { x, y, scale } = toViewPoint(event);
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
      },
    ]);
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
    <>
      <svg
        viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
        preserveAspectRatio="none"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-label={gt("Draw on {name}", { name: target.name })}
        role="img"
        className={cn(
          "absolute inset-0 size-full touch-none rounded-lg",
          tool === "draw" ? "cursor-crosshair" : "cursor-pointer",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      >
        {tool === "erase" && (
          <g>
            {strokes.map((stroke) => (
              <path
                key={stroke.id}
                data-stroke-id={stroke.id}
                d={stroke.path}
                stroke="transparent"
                strokeWidth={ERASER_SCREEN_WIDTH}
                vectorEffect="non-scaling-stroke"
                pointerEvents="stroke"
              />
            ))}
          </g>
        )}
        {strokes.map((stroke) => (
          <path
            key={stroke.id}
            data-stroke-id={stroke.id}
            d={stroke.path}
            stroke={stroke.color}
            strokeWidth={stroke.width}
          />
        ))}
        <g ref={liveLayerRef} />
      </svg>
      {/* Floats above the image and takes no layout space, so entering edit mode moves nothing. */}
      <div className="absolute bottom-full left-1/2 z-10 mb-2 flex w-max max-w-[calc(100vw-7rem)] -translate-x-1/2 flex-col items-center gap-1 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-center gap-1">
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
              <span className="max-sm:sr-only">
                {gt("Draw", { $context: "drawing tool, freehand pen" })}
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="erase" aria-label={gt("Erase a stroke (E)")}>
              <EraserIcon />
              <span className="max-sm:sr-only">
                {gt("Erase", { $context: "drawing tool, removes a stroke" })}
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
          <div role="radiogroup" aria-label={gt("Stroke color")} className="flex items-center px-1">
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
            <span className="max-sm:sr-only">{gt("Undo")}</span>
          </Button>
          <Button ref={doneButtonRef} size="sm" onClick={() => void done()} disabled={saving}>
            {gt("Done")}
          </Button>
        </div>
        {failed ? (
          <p role="alert" className="px-2 pb-1 text-xs text-destructive">
            {gt("The drawing could not be saved. Try again or cancel.")}
          </p>
        ) : null}
      </div>
    </>
  );
}

import { m, type MessageResolver } from "~/i18n/messages";
import { msg, useGT, useMessages, T } from "gt-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  EraserIcon,
  EyeIcon,
  MessageCircleIcon,
  MousePointer2Icon,
  MoveUpRightIcon,
  PencilIcon,
  Redo2Icon,
  RotateCcwIcon,
  ScissorsIcon,
  SquareIcon,
  CircleIcon,
  Trash2Icon,
  TypeIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Popover, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  addImageEditorObject,
  anchoredImageEditorResize,
  buildImageEditorPrompt,
  commitImageEditorDocument,
  createImageEditorDocument,
  createImageEditorHistory,
  hitTestImageEditorObject,
  imageEditorObjectBounds,
  imageEditorSvgMarkup,
  redoImageEditor,
  removeImageEditorObject,
  reorderImageEditorObject,
  setImageEditorCrop,
  undoImageEditor,
  updateImageEditorObject,
  type ImageEditorDocument,
  type ImageEditorHistory,
  type ImageEditorObject,
  type ImageEditorPoint,
} from "./imageEditorDocument";
import { exportEditorImage, loadEditorImage } from "./imageEditorExport";
import { observeResize } from "~/lib/observeResize";
import { readMediaBlob } from "../media/mediaContent";
import { randomUUID } from "~/lib/utils";

import type { ImageEditorOptions } from "./imageEditorSession";

export interface ImageEditorResult {
  files: File[];
  prompt: string;
  mode: "replace" | "edit";
  document: ImageEditorDocument;
  originalFile: File;
  sessionFile?: File;
  options?: ImageEditorOptions;
}

interface ImageEditorProps {
  src: string;
  name: string;
  mimeType?: string | undefined;
  initialDocument?: ImageEditorDocument | undefined;
  initialOptions?: ImageEditorOptions | undefined;
  resolveSrc?: (() => Promise<string>) | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onCancel: () => void;
  onApply: (result: ImageEditorResult) => Promise<void>;
}

type Tool = ImageEditorObject["kind"] | "select" | "eraser" | "crop";
type Gesture = {
  pointerId: number;
  start: ImageEditorPoint;
  operation: "draw" | "move" | "resize" | "erase" | "crop";
  objectId: string | null;
  initial: ImageEditorDocument;
  document: ImageEditorDocument;
  points: ImageEditorPoint[];
};

const TOOLS: ReadonlyArray<{ value: Tool; label: string; icon: ReactNode }> = [
  { value: "select", label: msg("Select and move"), icon: <MousePointer2Icon /> },
  { value: "freehand", label: msg("Draw"), icon: <PencilIcon /> },
  { value: "arrow", label: msg("Arrow"), icon: <MoveUpRightIcon /> },
  { value: "rectangle", label: msg("Rectangle"), icon: <SquareIcon /> },
  { value: "ellipse", label: msg("Ellipse"), icon: <CircleIcon /> },
  { value: "text", label: msg("Text"), icon: <TypeIcon /> },
  { value: "pin", label: msg("Comment pin"), icon: <MessageCircleIcon /> },
  { value: "remove", label: msg("Removal brush"), icon: <ScissorsIcon /> },
  { value: "eraser", label: msg("Erase annotations"), icon: <EraserIcon /> },
  { value: "crop", label: msg("Crop"), icon: <ScissorsIcon /> },
];

const COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ffffff",
  "#111827",
];
const RATIOS = [
  { value: "original", label: msg("Original") },
  { value: "1:1", label: msg("Square · 1:1") },
  { value: "4:5", label: msg("Portrait · 4:5") },
  { value: "3:2", label: msg("Landscape · 3:2") },
  { value: "9:16", label: msg("Story · 9:16") },
  { value: "16:9", label: msg("Widescreen · 16:9") },
];

function EditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

function EditorNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <EditorField label={label}>
      <Input
        aria-label={label}
        size="compact"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Math.round(value * 100) / 100}
        onChange={(event) => {
          if (event.target.value === "") return;
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
        }}
      />
    </EditorField>
  );
}

function EditorStrokeSize({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const sliderValue = Math.min(max, Math.max(2, Math.round(value)));
  const ratio = (sliderValue - 2) / (max - 2);
  return (
    <EditorField label={label}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label={label}
          className="settings-slider min-w-0 flex-1"
          min={2}
          max={max}
          step={1}
          value={sliderValue}
          style={
            {
              "--settings-slider-progress": `${ratio * 100}%`,
              "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
            } as CSSProperties
          }
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <output className="min-w-8 text-right tabular-nums text-foreground">
          {Math.round(value * 100) / 100}
        </output>
      </div>
    </EditorField>
  );
}

function EditorSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <EditorField label={label}>
      <Select value={value} onValueChange={(next) => next !== null && onChange(next)} items={items}>
        <SelectTrigger size="compact" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </EditorField>
  );
}

function boundedPoint(event: PointerEvent<SVGSVGElement>, document: ImageEditorDocument) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(
      document.width,
      Math.max(0, ((event.clientX - bounds.left) / bounds.width) * document.width),
    ),
    y: Math.min(
      document.height,
      Math.max(0, ((event.clientY - bounds.top) / bounds.height) * document.height),
    ),
  };
}

function pathGeometry(points: ImageEditorPoint[]) {
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  return {
    x,
    y,
    width: Math.max(1, Math.max(...points.map((point) => point.x)) - x),
    height: Math.max(1, Math.max(...points.map((point) => point.y)) - y),
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
  };
}

function objectLabel(object: ImageEditorObject, index: number, resolve: MessageResolver = m) {
  if (object.kind === "text") return object.text || resolve(msg("Text"));
  if (object.kind === "pin") return resolve(msg("Comment {number}"), { number: index + 1 });
  if (object.kind === "remove") return resolve(msg("Removal selection"));
  const labels = {
    freehand: msg("Freehand"),
    arrow: msg("Arrow"),
    rectangle: msg("Rectangle"),
    ellipse: msg("Ellipse"),
  };
  return resolve(labels[object.kind]);
}

function matchesCleanDocument(document: ImageEditorDocument, clean: ImageEditorDocument | null) {
  if (document === clean) return true;
  if (
    !clean ||
    document.width !== clean.width ||
    document.height !== clean.height ||
    document.objects.length !== clean.objects.length ||
    document.objects.some((object, index) => object !== clean.objects[index])
  )
    return false;
  return (
    document.crop === clean.crop ||
    (document.crop !== null &&
      clean.crop !== null &&
      document.crop.x === clean.crop.x &&
      document.crop.y === clean.crop.y &&
      document.crop.width === clean.crop.width &&
      document.crop.height === clean.crop.height)
  );
}

/** Use the browser's SVG font shaping, including kerning and spacing, for export geometry. */
function fitTextDocument(document: ImageEditorDocument, candidate: ImageEditorObject | string) {
  const object =
    typeof candidate === "string"
      ? document.objects.find((entry) => entry.id === candidate)
      : candidate;
  if (object?.kind !== "text") return document;
  const namespace = "http://www.w3.org/2000/svg";
  const svg = window.document.createElementNS(namespace, "svg");
  const text = window.document.createElementNS(namespace, "text");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.style.visibility = "hidden";
  text.setAttribute("font-family", object.fontFamily);
  text.setAttribute("font-size", String(object.fontSize));
  text.setAttribute("letter-spacing", String(object.letterSpacing));
  text.setAttribute("word-spacing", String(object.wordSpacing ?? 0));
  svg.append(text);
  window.document.body.append(svg);
  const lines = object.curve ? [object.text.split("\n").join(" ")] : object.text.split("\n");
  let advance = 0;
  try {
    for (const line of lines) {
      text.textContent = line;
      advance = Math.max(advance, text.getComputedTextLength(), text.getBBox().width);
    }
  } finally {
    svg.remove();
  }
  // A glyph-sized inset contains side bearings and the rotated glyphs at curved endpoints.
  const width = Math.max(1, (advance + 2 * object.fontSize) * object.stretch);
  const height = Math.max(
    1,
    object.fontSize * 2.5 +
      Math.abs(object.curve) +
      (lines.length - 1) * object.fontSize * object.lineHeight,
  );
  return {
    ...document,
    objects: document.objects.map((entry) =>
      entry.id === object.id
        ? { ...object, ...anchoredImageEditorResize(object, width, height) }
        : entry,
    ),
  };
}

export function ImageEditor({
  src,
  name,
  mimeType,
  initialDocument,
  initialOptions,
  resolveSrc,
  onBusyChange,
  onDirtyChange,
  onCancel,
  onApply,
}: ImageEditorProps) {
  const gt = useGT();
  const messages = useMessages();
  const [history, setHistory] = useState<ImageEditorHistory | null>(() =>
    initialDocument ? createImageEditorHistory(initialDocument) : null,
  );
  const [tool, setTool] = useState<Tool>("freehand");
  const [color, setColor] = useState(COLORS[0]!);
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [highlightWidth, setHighlightWidth] = useState(3);
  const [brushWidth, setBrushWidth] = useState(3);
  const [fontSize, setFontSize] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inlineAnnotation, setInlineAnnotation] = useState<{
    id: string;
    point: ImageEditorPoint;
  } | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [removeBackground, setRemoveBackground] = useState(
    initialOptions?.removeBackground ?? false,
  );
  const [aspectRatio, setAspectRatio] = useState<string>(initialOptions?.aspectRatio ?? "original");
  const [instructions, setInstructions] = useState(initialOptions?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [frozenSrc, setFrozenSrc] = useState<string | null>(null);
  const [detectedGif, setDetectedGif] = useState(false);
  const [sourceLoaded, setSourceLoaded] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<SVGSVGElement>(null);
  const annotationAnchorRef = useRef<HTMLSpanElement>(null);
  const annotationInputRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const [cleanDocument, setCleanDocument] = useState<ImageEditorDocument | null>(
    initialDocument ?? null,
  );
  const fieldEdit = useRef<{ target: EventTarget; committed: boolean } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- late exports must not submit or allocate a still-frame URL after the editor unmounts
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observe the external canvas viewport so image coordinates stay independent of the panel layout
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, ([entry]) => {
      if (!entry) return;
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the decoded still-frame URL belongs to this editor session
  useEffect(
    () => () => {
      if (frozenSrc) URL.revokeObjectURL(frozenSrc);
    },
    [frozenSrc],
  );

  const document = gesture?.document ?? history?.present ?? null;
  const declaredGif =
    mimeType?.split(";", 1)[0]?.toLowerCase() === "image/gif" ||
    /\.gif(?:[?#]|$)/i.test(name) ||
    /^data:image\/gif[;,]/i.test(src);
  const isGif = detectedGif || declaredGif;
  const canEdit = sourceLoaded && document !== null && (!isGif || frozenSrc !== null);
  const selected = document?.objects.find((object) => object.id === selectedId) ?? null;
  const inlineObject =
    selected?.id === inlineAnnotation?.id && (selected?.kind === "pin" || selected?.kind === "text")
      ? selected
      : null;
  const selectionBounds = selected ? imageEditorObjectBounds(selected) : null;
  const pins = document?.objects.filter((object) => object.kind === "pin") ?? [];
  const hasRemoval = document?.objects.some((object) => object.kind === "remove") ?? false;
  const fitScale = document
    ? Math.min(
        1,
        Math.max(1, viewportSize.width - 32) / document.width,
        Math.max(1, viewportSize.height - 32) / document.height,
      )
    : 1;
  const scale = fitScale * zoom;
  const selectionPadding = 5 / scale;
  const handleSize = 12 / scale;
  // Size controls use fitted-view pixels; documents retain original image pixels, independent of zoom.
  const creationStrokeWidth = (tool === "freehand" ? strokeWidth : highlightWidth) / fitScale;
  const creationBrushWidth = brushWidth / fitScale;
  const creationFontSize = fontSize ?? 24 / fitScale;
  const strokeTool = tool === "select" ? (selected?.kind ?? "freehand") : tool;
  const strokeSelection = selected?.kind === strokeTool ? selected : null;
  const strokeSize = strokeSelection
    ? strokeSelection.strokeWidth * fitScale
    : strokeTool === "remove"
      ? brushWidth
      : strokeTool === "freehand"
        ? strokeWidth
        : highlightWidth;
  // Live gestures are protected without inspecting their changing point arrays.
  const committedDocument = history?.present;
  const dirty =
    gesture !== null ||
    (committedDocument !== undefined && !matchesCleanDocument(committedDocument, cleanDocument)) ||
    instructions !== (initialOptions?.instructions ?? "") ||
    removeBackground !== (initialOptions?.removeBackground ?? false) ||
    aspectRatio !== (initialOptions?.aspectRatio ?? "original");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the parent must protect unsaved work when its gallery or modal receives an outside interaction
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function setWorking(value: boolean) {
    if (!mounted.current) return;
    setBusy(value);
    onBusyChange?.(value);
  }

  function commit(next: ImageEditorDocument, coalesceField = false) {
    if (busy) return;
    const edit = coalesceField ? fieldEdit.current : null;
    const replace = edit?.committed ?? false;
    if (edit) edit.committed = true;
    else fieldEdit.current = null;
    setHistory(
      (current) =>
        current &&
        (replace
          ? { ...current, present: next, future: [] }
          : commitImageEditorDocument(current, next)),
    );
    setError(null);
  }

  function updateSelected(patch: Partial<ImageEditorObject>) {
    if (!history || !selected || busy) return;
    const next = updateImageEditorObject(history.present, selected.id, patch);
    const object = next.objects.find((entry) => entry.id === selected.id);
    commit(
      object?.kind === "text" &&
        Object.keys(patch).some((key) =>
          [
            "text",
            "fontFamily",
            "fontSize",
            "letterSpacing",
            "wordSpacing",
            "lineHeight",
            "stretch",
            "curve",
          ].includes(key),
        )
        ? fitTextDocument(next, object)
        : next,
      true,
    );
  }

  function focusCanvas() {
    canvasRef.current?.focus({ preventScroll: true });
  }

  function finishInlineAnnotation() {
    setInlineAnnotation(null);
    focusCanvas();
  }

  function chooseTool(next: Tool) {
    setInlineAnnotation(null);
    setTool(next);
    setShowOriginal(false);
  }

  function startGesture(event: PointerEvent<SVGSVGElement>) {
    if (!history || !canEdit || busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    if (tool !== "pin" && tool !== "text") event.currentTarget.setPointerCapture(event.pointerId);
    setInlineAnnotation(null);
    const initial = history.present;
    const point = boundedPoint(event, initial);
    const hit = hitTestImageEditorObject(initial, point, scale);
    const resize =
      event.target instanceof Element && event.target.getAttribute("data-resize") === "true";
    setShowOriginal(false);

    if (tool === "select") {
      const target = resize && selected ? selected : hit;
      setSelectedId(target?.id ?? null);
      if (target) {
        setGesture({
          pointerId: event.pointerId,
          start: point,
          operation: resize ? "resize" : "move",
          objectId: target.id,
          initial,
          document: initial,
          points: [],
        });
      }
      return;
    }

    if (tool === "eraser") {
      const next = hit ? removeImageEditorObject(initial, hit.id) : initial;
      setGesture({
        pointerId: event.pointerId,
        start: point,
        operation: "erase",
        objectId: null,
        initial,
        document: next,
        points: [],
      });
      setSelectedId(null);
      return;
    }

    if (tool === "crop") {
      setGesture({
        pointerId: event.pointerId,
        start: point,
        operation: "crop",
        objectId: null,
        initial,
        document: initial,
        points: [],
      });
      setSelectedId(null);
      return;
    }

    const id = randomUUID();
    const common = {
      id,
      x: point.x,
      y: point.y,
      width: 1,
      height: 1,
      rotation: 0,
      color,
      strokeWidth: creationStrokeWidth,
    };
    const object: ImageEditorObject =
      tool === "text"
        ? {
            ...common,
            kind: "text",
            width: creationFontSize * 5,
            height: creationFontSize * 1.2,
            text: gt("Text"),
            fontFamily: "sans-serif",
            fontSize: creationFontSize,
            align: "left",
            letterSpacing: 0,
            lineHeight: 1.2,
            stretch: 1,
            curve: 0,
          }
        : tool === "pin"
          ? {
              ...common,
              kind: "pin",
              x: point.x - 12 / fitScale,
              y: point.y - 12 / fitScale,
              width: 24 / fitScale,
              height: 24 / fitScale,
              comment: "",
              strokeWidth: Math.max(2, creationStrokeWidth),
            }
          : tool === "freehand" || tool === "remove"
            ? {
                ...common,
                kind: tool,
                strokeWidth: tool === "remove" ? creationBrushWidth : creationStrokeWidth,
                points: [{ x: 0, y: 0 }],
              }
            : tool === "arrow"
              ? {
                  ...common,
                  kind: "arrow",
                  points: [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ],
                }
              : { ...common, kind: tool };
    const next = fitTextDocument(addImageEditorObject(initial, object), object);
    setSelectedId(id);
    if (tool === "text" || tool === "pin") {
      commit(next);
      setTool("select");
      setInlineAnnotation({ id, point });
    } else {
      setGesture({
        pointerId: event.pointerId,
        start: point,
        operation: "draw",
        objectId: id,
        initial,
        document: next,
        points: [point],
      });
    }
  }

  function moveGesture(event: PointerEvent<SVGSVGElement>) {
    if (!gesture || gesture.pointerId !== event.pointerId || !history) return;
    event.preventDefault();
    event.stopPropagation();
    const point = boundedPoint(event, gesture.initial);
    const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
    let next = gesture.document;
    let points = gesture.points;
    if (gesture.operation === "erase") {
      const hit = hitTestImageEditorObject(next, point, scale);
      if (hit) next = removeImageEditorObject(next, hit.id);
    } else if (gesture.operation === "crop") {
      next = setImageEditorCrop(gesture.initial, {
        x: Math.min(point.x, gesture.start.x),
        y: Math.min(point.y, gesture.start.y),
        width: Math.max(1, Math.abs(delta.x)),
        height: Math.max(1, Math.abs(delta.y)),
      });
    } else if (gesture.objectId) {
      const object = gesture.initial.objects.find((candidate) => candidate.id === gesture.objectId);
      const drawn = next.objects.find((candidate) => candidate.id === gesture.objectId);
      if (gesture.operation === "move" && object) {
        next = updateImageEditorObject(gesture.initial, object.id, {
          x: object.x + delta.x,
          y: object.y + delta.y,
        });
      } else if (gesture.operation === "resize" && object) {
        const radians = (object.rotation * Math.PI) / 180;
        const cosine = Math.cos(radians);
        const sine = Math.sin(radians);
        const width = Math.max(1, object.width + delta.x * cosine + delta.y * sine);
        const height = Math.max(1, object.height - delta.x * sine + delta.y * cosine);
        next = updateImageEditorObject(
          gesture.initial,
          object.id,
          anchoredImageEditorResize(object, width, height),
        );
      } else if (drawn) {
        if (drawn.kind === "freehand" || drawn.kind === "remove") {
          points =
            gesture.points.length < 8192
              ? [...gesture.points, point]
              : [...gesture.points.slice(0, -1), point];
          next = updateImageEditorObject(next, drawn.id, pathGeometry(points));
        } else if (drawn.kind === "arrow") {
          next = updateImageEditorObject(next, drawn.id, pathGeometry([gesture.start, point]));
        } else {
          next = updateImageEditorObject(next, drawn.id, {
            x: Math.min(point.x, gesture.start.x),
            y: Math.min(point.y, gesture.start.y),
            width: Math.max(1, Math.abs(delta.x)),
            height: Math.max(1, Math.abs(delta.y)),
          });
        }
      }
    }
    setGesture({ ...gesture, document: next, points });
  }

  function endGesture(event: PointerEvent<SVGSVGElement>, cancel = false) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!cancel) commit(gesture.document);
    setGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function buildFiles(mode: "replace" | "edit") {
    if (!document) return null;
    const source = resolveSrc ? await resolveSrc() : src;
    const blob = await readMediaBlob(source);
    if (
      !frozenSrc &&
      (blob.type.split(";", 1)[0] === "image/gif" ||
        /^GIF8[79]a$/.test(await blob.slice(0, 6).text()))
    ) {
      setDetectedGif(true);
      throw new Error(
        gt(
          "This is a GIF. Choose Edit a still frame to create a PNG. To work on the animation, save it with a .gif filename and reopen it from the gallery.",
        ),
      );
    }
    const originalFile = new File([blob], name, { type: blob.type || "image/png" });
    const objectUrl = frozenSrc ?? URL.createObjectURL(originalFile);
    const imageResult = await loadEditorImage(objectUrl).then(
      (image) => ({ image, error: null }),
      (cause: unknown) => ({ image: null, error: cause }),
    );
    if (!frozenSrc) URL.revokeObjectURL(objectUrl);
    if (!imageResult.image) throw imageResult.error;
    const image = imageResult.image;
    if (mode === "replace") {
      const file = await exportEditorImage(image, document, name, { mode: "annotated" });
      return {
        files: [file],
        originalFile,
        sessionFile: file,
      };
    }
    const original = await exportEditorImage(image, document, name, { mode: "original" });
    const guidance = await exportEditorImage(image, document, name, { mode: "annotated" });
    const files = [original, guidance];
    if (hasRemoval) files.push(await exportEditorImage(image, document, name, { mode: "mask" }));
    return { files, originalFile, sessionFile: guidance };
  }

  async function submit() {
    if (!document || !canEdit || busy) return;
    setWorking(true);
    setError(null);
    await buildFiles("edit")
      .then(async (result) => {
        if (!result || !mounted.current) return;
        await onApply({
          ...result,
          mode: "edit",
          document,
          options: { instructions, removeBackground, aspectRatio },
          prompt: buildImageEditorPrompt(document, { instructions, removeBackground, aspectRatio }),
        });
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : gt("Unable to prepare this image. Please try again."),
        ),
      );
    setWorking(false);
  }

  async function download() {
    if (!document || !canEdit || busy) return;
    setWorking(true);
    setError(null);
    await buildFiles("replace")
      .then((result) => {
        const file = result?.files[0];
        if (!file || !mounted.current) return;
        const url = URL.createObjectURL(file);
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        // Downloads consume the URL after the click handler returns.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : gt("Unable to save this image.")),
      );
    setWorking(false);
  }

  async function freezeGif() {
    if (!document || busy) return;
    setWorking(true);
    setError(null);
    await (resolveSrc ? resolveSrc() : Promise.resolve(src))
      .then(loadEditorImage)
      .then((image) =>
        exportEditorImage(
          image,
          createImageEditorDocument(image.naturalWidth, image.naturalHeight),
          name,
          { mode: "original" },
        ),
      )
      .then((file) => {
        if (mounted.current) setFrozenSrc(URL.createObjectURL(file));
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : gt("Unable to decode a still frame.")),
      );
    setWorking(false);
  }

  return (
    <section
      aria-label={gt("Image editor")}
      aria-busy={busy}
      className="@container/image-editor flex h-full max-h-full w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-background text-foreground shadow-2xl"
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          fieldEdit.current = { target: event.target, committed: false };
      }}
      onBlurCapture={(event) => {
        if (fieldEdit.current?.target === event.target) fieldEdit.current = null;
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && !busy) {
          if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement ||
            (event.target instanceof HTMLElement && event.target.isContentEditable)
          ) {
            event.preventDefault();
            event.stopPropagation();
            event.target.blur();
            focusCanvas();
          } else if (gesture) {
            event.preventDefault();
            event.stopPropagation();
            setGesture(null);
          }
          return;
        }
        event.stopPropagation();
        if (busy) {
          if (event.key !== "Tab") event.preventDefault();
          return;
        }
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)
        )
          return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          setHistory(
            (current) =>
              current && (event.shiftKey ? redoImageEditor(current) : undoImageEditor(current)),
          );
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
          event.preventDefault();
          setHistory((current) => current && redoImageEditor(current));
        } else if ((event.key === "Delete" || event.key === "Backspace") && selected && document) {
          event.preventDefault();
          focusCanvas();
          commit(removeImageEditorObject(document, selected.id));
          setSelectedId(null);
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{gt("Edit {name}", { name })}</h2>
          <p className="text-xs text-muted-foreground">
            {document
              ? gt("{width} × {height} · Original preserved", {
                  width: document.width,
                  height: document.height,
                })
              : gt("Loading image…")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={gt("Undo image edit")}
          disabled={!history?.past.length || busy}
          onClick={() => setHistory((current) => current && undoImageEditor(current))}
        >
          <Undo2Icon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={gt("Redo image edit")}
          disabled={!history?.future.length || busy}
          onClick={() => setHistory((current) => current && redoImageEditor(current))}
        >
          <Redo2Icon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={gt("Close image editor")}
          disabled={busy}
          onClick={onCancel}
        >
          <XIcon />
        </Button>
      </header>
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5"
        role="toolbar"
        aria-label={gt("Image editing tools")}
      >
        {TOOLS.map((entry) => (
          <Button
            key={entry.value}
            variant={tool === entry.value ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={messages(entry.label)}
            title={messages(entry.label)}
            aria-pressed={tool === entry.value}
            disabled={!canEdit || busy}
            onClick={() => chooseTool(entry.value)}
          >
            {entry.icon}
          </Button>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showOriginal}
          disabled={!document}
          onClick={() => setShowOriginal((value) => !value)}
        >
          <EyeIcon />
          {showOriginal ? gt("Show edits") : gt("Original")}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={gt("Zoom out")}
            disabled={zoom <= 1}
            onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
          >
            −
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setZoom(1)} aria-label={gt("Fit image")}>
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={gt("Zoom in")}
            disabled={zoom >= 4}
            onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
          >
            +
          </Button>
        </div>
      </div>
      {isGif && !frozenSrc && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <p className="min-w-0 flex-1">
            {declaredGif
              ? gt(
                  "This is a GIF. Editing here creates a still PNG; use the gallery’s frame sheet to work on the animation.",
                )
              : gt(
                  "This is a GIF. Editing here creates a still PNG; to work on the animation, save it with a .gif filename and reopen it from the gallery.",
                )}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!document || busy}
            onClick={() => {
              void freezeGif();
            }}
          >
            <T>Edit a still frame</T>
          </Button>
        </div>
      )}
      <div className="flex min-h-48 flex-1 @max-3xl/image-editor:min-h-[28rem] @max-3xl/image-editor:flex-col">
        <div
          ref={viewportRef}
          className="flex min-h-0 min-w-0 flex-1 overflow-auto scrollbar-gutter-both bg-muted/40 @max-3xl/image-editor:min-h-48"
          role="region"
          aria-label={gt("Image editing canvas")}
        >
          <div className="m-auto shrink-0 p-4">
            <div
              className="relative"
              style={
                document
                  ? { width: document.width * scale, height: document.height * scale }
                  : undefined
              }
            >
              <img
                src={frozenSrc ?? src}
                alt={name}
                draggable={false}
                className={
                  document ? "block h-full w-full select-none" : "block max-h-96 max-w-full"
                }
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setSourceLoaded(true);
                  if (!history) {
                    const loaded = createImageEditorDocument(
                      image.naturalWidth,
                      image.naturalHeight,
                    );
                    setCleanDocument(loaded);
                    setHistory((current) => current ?? createImageEditorHistory(loaded));
                  }
                }}
                onError={() => {
                  setSourceLoaded(false);
                  setError(
                    gt(
                      "The editor could not decode this image. It supports formats your browser can display; convert the image to PNG or JPEG and reopen it.",
                    ),
                  );
                }}
              />
              {document && (
                <svg
                  ref={canvasRef}
                  role="application"
                  aria-roledescription={gt("image annotation canvas")}
                  aria-label={gt("Editable annotations")}
                  tabIndex={0}
                  className={`absolute inset-0 h-full w-full touch-none outline-none ${tool === "select" ? "cursor-default" : tool === "eraser" ? "cursor-cell" : "cursor-crosshair"}`}
                  viewBox={`0 0 ${document.width} ${document.height}`}
                  onPointerDown={startGesture}
                  onPointerMove={moveGesture}
                  onPointerUp={(event) => endGesture(event)}
                  onPointerCancel={(event) => endGesture(event, true)}
                >
                  <title>
                    <T>Image annotations. Choose a tool, then drag on the image.</T>
                  </title>
                  {!showOriginal && (
                    <g
                      pointerEvents="none"
                      dangerouslySetInnerHTML={{ __html: imageEditorSvgMarkup(document) }}
                    />
                  )}
                  {!showOriginal && document.crop && (
                    <rect
                      x={document.crop.x}
                      y={document.crop.y}
                      width={document.crop.width}
                      height={document.crop.height}
                      fill="none"
                      stroke="var(--color-white)"
                      strokeWidth={2 / scale}
                      strokeDasharray={`${8 / scale} ${4 / scale}`}
                      pointerEvents="none"
                    />
                  )}
                  {!showOriginal && selected && selectionBounds && tool === "select" && (
                    <g>
                      <rect
                        x={selectionBounds.x - selectionPadding}
                        y={selectionBounds.y - selectionPadding}
                        width={selectionBounds.width + 2 * selectionPadding}
                        height={selectionBounds.height + 2 * selectionPadding}
                        fill="none"
                        stroke="var(--color-blue-500)"
                        strokeWidth={1.5 / scale}
                        pointerEvents="none"
                      />
                      <g
                        transform={`translate(${selected.x} ${selected.y}) rotate(${selected.rotation} ${selected.width / 2} ${selected.height / 2})`}
                      >
                        <rect
                          data-resize="true"
                          x={
                            selected.width < 2 * handleSize
                              ? selected.width + selectionPadding
                              : selected.width - handleSize / 2
                          }
                          y={
                            selected.height < 2 * handleSize
                              ? selected.height + selectionPadding
                              : selected.height - handleSize / 2
                          }
                          width={handleSize}
                          height={handleSize}
                          fill="var(--color-white)"
                          stroke="var(--color-blue-500)"
                          strokeWidth={1.5 / scale}
                          className="cursor-nwse-resize"
                        />
                      </g>
                    </g>
                  )}
                </svg>
              )}
              <Popover
                open={inlineObject !== null && !showOriginal && !busy}
                onOpenChange={(open) => {
                  if (!open) setInlineAnnotation(null);
                }}
              >
                <span
                  ref={annotationAnchorRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute size-px"
                  style={{
                    left: (inlineAnnotation?.point.x ?? 0) * scale,
                    top: (inlineAnnotation?.point.y ?? 0) * scale,
                  }}
                />
                <PopoverPopup
                  anchor={annotationAnchorRef}
                  side="right"
                  align="start"
                  sideOffset={16}
                  width="sm"
                  padding="compact"
                  hideWhenAnchorHidden
                  initialFocus={annotationInputRef}
                  finalFocus={false}
                  aria-label={gt("Annotation text")}
                  onKeyDownCapture={(event) => {
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                      event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
                      event.preventDefault();
                      event.stopPropagation();
                      finishInlineAnnotation();
                    }
                  }}
                >
                  {inlineObject && (
                    <div className="space-y-2">
                      <PopoverTitle>
                        {inlineObject.kind === "pin" ? gt("Comment") : gt("Text annotation")}
                      </PopoverTitle>
                      <Textarea
                        ref={annotationInputRef}
                        aria-label={
                          inlineObject.kind === "pin"
                            ? gt("Annotation comment")
                            : gt("Annotation text")
                        }
                        placeholder={gt("Describe the change here…")}
                        size="sm"
                        rows={2}
                        className="[&_textarea]:max-h-32"
                        value={
                          inlineObject.kind === "pin" ? inlineObject.comment : inlineObject.text
                        }
                        onFocus={(event) => {
                          if (inlineObject.kind === "text") event.currentTarget.select();
                        }}
                        onChange={(event) =>
                          updateSelected(
                            inlineObject.kind === "pin"
                              ? { comment: event.target.value }
                              : { text: event.target.value },
                          )
                        }
                      />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-3xs text-muted-foreground">
                          <T>Shift+Enter for a new line</T>
                        </span>
                        <Button size="sm" onClick={finishInlineAnnotation}>
                          <T>Done</T>
                        </Button>
                      </div>
                    </div>
                  )}
                </PopoverPopup>
              </Popover>
            </div>
          </div>
        </div>
        <fieldset
          disabled={busy || !canEdit}
          className="flex min-h-0 min-w-0 w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-3 @max-3xl/image-editor:max-h-64 @max-3xl/image-editor:w-full @max-3xl/image-editor:border-l-0 @max-3xl/image-editor:border-t"
          aria-label={gt("Image edit properties")}
        >
          <div className="space-y-2">
            <h3 className="text-xs font-medium">
              {messages(TOOLS.find((entry) => entry.value === tool)!.label)}
            </h3>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label={gt("Annotation color")}
            >
              {COLORS.map((swatch) => (
                <button
                  type="button"
                  key={swatch}
                  aria-label={gt("Color {color}", { color: swatch })}
                  aria-pressed={(selected?.color ?? color) === swatch}
                  className="size-6 rounded-full border border-black/20 -outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-ring focus-visible:outline-2 focus-visible:outline-ring"
                  style={{ backgroundColor: swatch }}
                  onClick={() => {
                    setColor(swatch);
                    if (selected) updateSelected({ color: swatch });
                  }}
                />
              ))}
            </div>
            <EditorStrokeSize
              label={strokeTool === "remove" ? gt("Removal brush size") : gt("Stroke size")}
              max={strokeTool === "freehand" ? 10 : 30}
              value={strokeSize}
              onChange={(value) => {
                if (strokeTool === "remove") setBrushWidth(value);
                else if (strokeTool === "freehand") setStrokeWidth(value);
                else setHighlightWidth(value);
                if (strokeSelection) updateSelected({ strokeWidth: value / fitScale });
              }}
            />
            {tool === "text" && !selected && (
              <EditorNumber
                label={gt("Text size")}
                value={creationFontSize}
                min={1}
                max={600}
                onChange={setFontSize}
              />
            )}
            <p className="text-xs text-muted-foreground">
              {tool === "remove"
                ? gt(
                    "Paint over objects to remove. The original and a selection guide are added to your edit request.",
                  )
                : tool === "pin"
                  ? gt("Click to pin a location, then type your feedback beside it.")
                  : tool === "eraser"
                    ? gt("Drag over annotations to erase them. Undo restores them.")
                    : tool === "crop"
                      ? gt("Drag a rectangle to crop the exported image.")
                      : gt("Drag to draw. Use Select to move or resize annotations.")}
            </p>
          </div>
          {selected && (
            <div className="space-y-2 border-t border-border pt-3">
              <h3 className="text-xs font-medium">{gt("Selected annotation")}</h3>
              {selected.kind === "pin" && (
                <EditorField label={gt("Comment")}>
                  <Textarea
                    size="sm"
                    aria-label={gt("Comment")}
                    value={selected.comment}
                    onChange={(event) => updateSelected({ comment: event.target.value })}
                    placeholder={gt("Describe the change at this location…")}
                  />
                </EditorField>
              )}
              {selected.kind === "text" && (
                <>
                  <EditorField label={gt("Text content")}>
                    <Textarea
                      aria-label={gt("Text content")}
                      size="sm"
                      value={selected.text}
                      onChange={(event) => updateSelected({ text: event.target.value })}
                    />
                  </EditorField>
                  <EditorSelect
                    label={gt("Font")}
                    value={selected.fontFamily}
                    items={[
                      { value: "sans-serif", label: gt("Sans serif") },
                      { value: "serif", label: gt("Serif") },
                      { value: "monospace", label: gt("Monospace") },
                      { value: "cursive", label: gt("Handwriting") },
                    ]}
                    onChange={(value) => updateSelected({ fontFamily: value })}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <EditorNumber
                      label={gt("Text size")}
                      value={selected.fontSize}
                      min={1}
                      max={600}
                      onChange={(value) => updateSelected({ fontSize: value })}
                    />
                    <EditorNumber
                      label={gt("Letter spacing")}
                      value={selected.letterSpacing}
                      min={-50}
                      max={100}
                      step={0.5}
                      onChange={(value) => updateSelected({ letterSpacing: value })}
                    />
                    <EditorNumber
                      label={gt("Word spacing")}
                      value={selected.wordSpacing ?? 0}
                      min={-50}
                      max={100}
                      step={0.5}
                      onChange={(value) => updateSelected({ wordSpacing: value })}
                    />
                    <EditorNumber
                      label={gt("Line height")}
                      value={selected.lineHeight}
                      min={0.5}
                      max={5}
                      step={0.1}
                      onChange={(value) => updateSelected({ lineHeight: value })}
                    />
                    <EditorNumber
                      label={gt("Character width")}
                      value={selected.stretch}
                      min={0.2}
                      max={4}
                      step={0.1}
                      onChange={(value) => updateSelected({ stretch: value })}
                    />
                    <EditorNumber
                      label={gt("Text curve")}
                      value={selected.curve}
                      min={-500}
                      max={500}
                      onChange={(value) => updateSelected({ curve: value })}
                    />
                  </div>
                  <EditorSelect
                    label={gt("Text alignment")}
                    value={selected.align}
                    items={[
                      { value: "left", label: gt("Left") },
                      { value: "center", label: gt("Center") },
                      { value: "right", label: gt("Right") },
                    ]}
                    onChange={(value) => {
                      if (value === "left" || value === "center" || value === "right")
                        updateSelected({ align: value });
                    }}
                  />
                </>
              )}
              <div className="grid grid-cols-2 gap-2">
                <EditorNumber
                  label={gt("Position X")}
                  value={selected.x}
                  onChange={(value) => updateSelected({ x: value })}
                />
                <EditorNumber
                  label={gt("Position Y")}
                  value={selected.y}
                  onChange={(value) => updateSelected({ y: value })}
                />
                <EditorNumber
                  label={gt("Width")}
                  value={selected.width}
                  min={1}
                  onChange={(value) => updateSelected({ width: value })}
                />
                <EditorNumber
                  label={gt("Height")}
                  value={selected.height}
                  min={1}
                  onChange={(value) => updateSelected({ height: value })}
                />
                <EditorNumber
                  label={gt("Rotation")}
                  value={selected.rotation}
                  min={-360}
                  max={360}
                  onChange={(value) => updateSelected({ rotation: value })}
                />
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={gt("Move layer backward")}
                  onClick={() =>
                    document && commit(reorderImageEditorObject(document, selected.id, "backward"))
                  }
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={gt("Move layer forward")}
                  onClick={() =>
                    document && commit(reorderImageEditorObject(document, selected.id, "forward"))
                  }
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost-destructive"
                  aria-label={gt("Delete selected annotation")}
                  onClick={() => {
                    focusCanvas();
                    if (document) commit(removeImageEditorObject(document, selected.id));
                    setSelectedId(null);
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-2 border-t border-border pt-3">
            <h3 className="text-xs font-medium">
              <T>Generate an edit</T>
            </h3>
            <Button
              size="sm"
              variant={removeBackground ? "secondary" : "outline"}
              aria-pressed={removeBackground}
              onClick={() => setRemoveBackground((value) => !value)}
            >
              <T>Remove background</T>
            </Button>
            <EditorSelect
              label={gt("Regenerate aspect ratio")}
              value={aspectRatio}
              items={RATIOS.map((item) => ({ ...item, label: messages(item.label) }))}
              onChange={setAspectRatio}
            />
            <EditorField label={gt("Edit instructions")}>
              <Textarea
                aria-label={gt("Edit instructions")}
                size="sm"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder={gt("Describe the result you want…")}
              />
            </EditorField>
          </div>
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium">
                {gt("Staged changes ({count})", {
                  count: (document?.objects.length ?? 0) + (document?.crop ? 1 : 0),
                })}
              </h3>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={gt("Reset all image edits")}
                disabled={!document || busy || (!document.objects.length && !document.crop)}
                onClick={() => {
                  focusCanvas();
                  if (document) commit(createImageEditorDocument(document.width, document.height));
                  setSelectedId(null);
                }}
              >
                <RotateCcwIcon />
              </Button>
            </div>
            {document?.crop && (
              <div className="flex items-center gap-1 text-xs">
                <span className="flex-1">
                  {gt("Crop · {width} × {height}", {
                    width: Math.round(document.crop.width),
                    height: Math.round(document.crop.height),
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-micro"
                  aria-label={gt("Revert crop")}
                  onClick={() => {
                    focusCanvas();
                    commit(setImageEditorCrop(document, null));
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            )}
            {document?.objects.map((object, index) => (
              <div className="flex items-center gap-1" key={object.id}>
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  aria-pressed={selectedId === object.id}
                  onClick={() => {
                    setSelectedId(object.id);
                    setTool("select");
                    setShowOriginal(false);
                  }}
                >
                  {objectLabel(
                    object,
                    object.kind === "pin" ? pins.findIndex((pin) => pin.id === object.id) : index,
                    messages,
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="icon-micro"
                  aria-label={gt("Revert {name}", {
                    name: objectLabel(
                      object,
                      object.kind === "pin" ? pins.findIndex((pin) => pin.id === object.id) : index,
                      messages,
                    ),
                  })}
                  onClick={() => {
                    focusCanvas();
                    commit(removeImageEditorObject(document, object.id));
                    if (selectedId === object.id) setSelectedId(null);
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            {!document?.objects.length && !document?.crop && (
              <p className="text-xs text-muted-foreground">
                <T>Your annotations and selections appear here.</T>
              </p>
            )}
          </div>
        </fieldset>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <div
          className="min-w-0 basis-full text-xs text-muted-foreground @min-4xl/image-editor:flex-1 @min-4xl/image-editor:basis-0"
          aria-live="polite"
        >
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : busy ? (
            gt("Preparing images…")
          ) : (
            gt("The original, annotations, and instructions will be added to your message.")
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!canEdit || busy}
          onClick={() => {
            void download();
          }}
        >
          <DownloadIcon />
          <T>Save PNG</T>
        </Button>
        <Button
          size="sm"
          disabled={!canEdit || busy}
          onClick={() => {
            void submit();
          }}
        >
          <T>Add edit request</T>
        </Button>
      </footer>
    </section>
  );
}

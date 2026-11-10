import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  CropIcon,
  MoveUpRightIcon,
  PencilIcon,
  Redo2Icon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { compressImageToByteLimit } from "../../lib/imageCompression";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  ANNOTATION_COLORS,
  activeCrop,
  annotatedFileName,
  annotationScale,
  drawAnnotationOp,
  drawCropShade,
  exportAnnotatedImage,
  isMeaningfulOp,
  rectFromPoints,
  type AnnotationOp,
  type AnnotationPoint,
  type AnnotationRect,
  type AnnotationTool,
} from "./imageAnnotation";

export interface ImageAnnotationResult {
  readonly file: File;
  readonly crop: AnnotationRect | null;
  readonly imageSize: { readonly width: number; readonly height: number } | undefined;
}

const TOOLS: ReadonlyArray<{
  readonly tool: AnnotationTool;
  readonly label: string;
  readonly Icon: typeof PencilIcon;
}> = [
  { tool: "pen", label: "Draw", Icon: PencilIcon },
  { tool: "arrow", label: "Arrow", Icon: MoveUpRightIcon },
  { tool: "rect", label: "Box", Icon: SquareIcon },
  { tool: "text", label: "Text", Icon: TypeIcon },
  { tool: "crop", label: "Crop", Icon: CropIcon },
];

function isAnnotationTool(value: unknown): value is AnnotationTool {
  return TOOLS.some((entry) => entry.tool === value);
}

export function ImageAnnotationDialog({
  image,
  onClose,
  onSave,
}: {
  readonly image: ComposerImageAttachment | null;
  readonly onClose: () => void;
  readonly onSave: (result: ImageAnnotationResult) => void;
}) {
  return (
    <Dialog
      open={image !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-[min(96vw,1400px)]" {...composerFloatingLayerProps}>
        {image ? <AnnotationEditor key={image.id} image={image} onSave={onSave} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function paintBase(
  canvas: HTMLCanvasElement | null,
  source: HTMLImageElement | null,
  ops: ReadonlyArray<AnnotationOp>,
): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx || !source) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  for (const op of ops) drawAnnotationOp(ctx, op);
}

/** The in-progress stroke and crop shade live on their own canvas so dragging never repaints the image. */
function paintOverlay(
  canvas: HTMLCanvasElement | null,
  source: HTMLImageElement | null,
  ops: ReadonlyArray<AnnotationOp>,
  draft: AnnotationOp | null,
): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx || !source) return;
  const size = { width: source.naturalWidth, height: source.naturalHeight };
  ctx.clearRect(0, 0, size.width, size.height);
  const shownCrop = draft?.kind === "crop" ? draft.rect : activeCrop(ops);
  if (shownCrop) {
    drawCropShade(ctx, shownCrop, size, annotationScale(size.width, size.height).stroke);
  }
  if (draft && draft.kind !== "crop") drawAnnotationOp(ctx, draft);
}

/** Resolves to an error message when the result cannot be attached. */
async function renderAnnotatedFile(
  source: HTMLImageElement,
  name: string,
  ops: ReadonlyArray<AnnotationOp>,
): Promise<ImageAnnotationResult | string> {
  try {
    const size = { width: source.naturalWidth, height: source.naturalHeight };
    const blob = await exportAnnotatedImage(source, size, ops);
    const file = new File([blob], annotatedFileName(name), { type: "image/png" });
    const compressed = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!compressed.ok) return "The edited image is too large to attach.";
    return { file: compressed.file, crop: activeCrop(ops), imageSize: compressed.imageSize };
  } catch (error) {
    return error instanceof Error ? error.message : "Could not save the edited image.";
  }
}

interface TextDraft {
  readonly at: AnnotationPoint;
  readonly value: string;
  /** Rendered CSS pixels per image pixel when the draft opened. */
  readonly displayScale: number;
}

function AnnotationEditor({
  image,
  onSave,
}: {
  readonly image: ComposerImageAttachment;
  readonly onSave: (result: ImageAnnotationResult) => void;
}) {
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [ops, setOps] = useState<ReadonlyArray<AnnotationOp>>([]);
  const [redoStack, setRedoStack] = useState<ReadonlyArray<AnnotationOp>>([]);
  const [tool, setTool] = useState<AnnotationTool>("arrow");
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftOpRef = useRef<AnnotationOp | null>(null);
  const dragStartRef = useRef<AnnotationPoint | null>(null);

  const size = source ? { width: source.naturalWidth, height: source.naturalHeight } : null;
  const scale = size ? annotationScale(size.width, size.height) : null;
  const crop = activeCrop(ops);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- decodes the attachment into an image element the canvases draw from
  useEffect(() => {
    let cancelled = false;
    const element = new Image();
    element.src = image.previewUrl;
    element
      .decode()
      .then(() => {
        if (!cancelled) setSource(element);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [image.previewUrl]);

  const drawOverlay = () => paintOverlay(overlayCanvasRef.current, source, ops, draftOpRef.current);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints committed marks onto the canvases, which React does not render
  useEffect(() => {
    paintBase(baseCanvasRef.current, source, ops);
    paintOverlay(overlayCanvasRef.current, source, ops, null);
  }, [source, ops]);

  const commit = (op: AnnotationOp) => {
    if (!isMeaningfulOp(op)) return;
    setOps((current) => [...current, op]);
    setRedoStack([]);
    setSaveError(null);
  };

  const commitTextDraft = (): AnnotationOp | null => {
    if (!textDraft || !scale) return null;
    const op: AnnotationOp = {
      kind: "text",
      color,
      size: scale.text,
      at: textDraft.at,
      text: textDraft.value,
    };
    setTextDraft(null);
    if (!isMeaningfulOp(op)) return null;
    commit(op);
    return op;
  };

  const undo = () => {
    const last = ops.at(-1);
    if (!last) return;
    setOps(ops.slice(0, -1));
    setRedoStack([...redoStack, last]);
  };

  const redo = () => {
    const next = redoStack.at(-1);
    if (!next) return;
    setRedoStack(redoStack.slice(0, -1));
    setOps([...ops, next]);
  };

  const toImagePoint = (event: PointerEvent<HTMLCanvasElement>): AnnotationPoint | null => {
    if (!size) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * size.width,
      y: ((event.clientY - bounds.top) / bounds.height) * size.height,
    };
  };

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !size || !scale) return;
    const point = toImagePoint(event);
    if (!point) return;
    if (tool === "text") {
      event.preventDefault();
      if (textDraft) {
        commitTextDraft();
        return;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      setTextDraft({ at: point, value: "", displayScale: bounds.width / size.width });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = point;
    draftOpRef.current =
      tool === "pen"
        ? { kind: "pen", color, width: scale.stroke, points: [point] }
        : tool === "crop"
          ? { kind: "crop", rect: rectFromPoints(point, point, size) }
          : { kind: tool, color, width: scale.stroke, from: point, to: point };
    drawOverlay();
  };

  const moveStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const draft = draftOpRef.current;
    const start = dragStartRef.current;
    const point = draft && start ? toImagePoint(event) : null;
    if (!draft || !start || !point || !size) return;
    switch (draft.kind) {
      case "pen":
        draftOpRef.current = { ...draft, points: [...draft.points, point] };
        break;
      case "crop":
        draftOpRef.current = { kind: "crop", rect: rectFromPoints(start, point, size) };
        break;
      case "arrow":
      case "rect":
        draftOpRef.current = { ...draft, to: point };
        break;
      case "text":
        break;
    }
    drawOverlay();
  };

  const endStroke = () => {
    const draft = draftOpRef.current;
    draftOpRef.current = null;
    dragStartRef.current = null;
    if (draft) commit(draft);
    drawOverlay();
  };

  const save = async () => {
    if (!source || saving) return;
    const pendingText = commitTextDraft();
    setSaving(true);
    setSaveError(null);
    const result = await renderAnnotatedFile(
      source,
      image.name,
      pendingText ? [...ops, pendingText] : ops,
    );
    setSaving(false);
    if (typeof result === "string") setSaveError(result);
    else onSave(result);
  };

  const handleShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.target instanceof HTMLTextAreaElement) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      redo();
    } else if (key === "enter") {
      event.preventDefault();
      void save();
    } else {
      return;
    }
    event.stopPropagation();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clicking the canvas focuses the dialog root, above any element handler, so shortcuts listen on the document
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => handleShortcut(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  return (
    <div className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>Edit image</DialogTitle>
        <DialogDescription>
          Draw, point, label or crop before sending. The original is replaced when you apply.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        <ToggleGroup
          aria-label="Annotation tool"
          variant="default"
          size="sm"
          value={[tool]}
          onValueChange={(next) => {
            const value = next[0];
            if (!isAnnotationTool(value)) return;
            commitTextDraft();
            setTool(value);
          }}
        >
          {TOOLS.map(({ tool: value, label, Icon }) => (
            <Toggle key={value} value={value} aria-label={label} title={label}>
              <Icon />
            </Toggle>
          ))}
        </ToggleGroup>
        <div role="radiogroup" aria-label="Annotation color" className="flex items-center gap-1">
          {ANNOTATION_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={color === swatch}
              aria-label={`Color ${swatch}`}
              className={cn(
                "size-5 rounded-full border border-border shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                color === swatch && "ring-2 ring-foreground ring-inset",
              )}
              style={{ backgroundColor: swatch }}
              onClick={() => setColor(swatch)}
            />
          ))}
        </div>
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Undo"
            title="Undo"
            disabled={ops.length === 0}
            onClick={undo}
          >
            <Undo2Icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Redo"
            title="Redo"
            disabled={redoStack.length === 0}
            onClick={redo}
          >
            <Redo2Icon />
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={ops.length === 0}
            onClick={() => {
              setRedoStack([...redoStack, ...ops.toReversed()]);
              setOps([]);
            }}
          >
            Reset
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 justify-center px-6 pb-2">
        {loadFailed ? (
          <p role="alert" className="py-12 text-sm text-muted-foreground">
            This image can't be edited.
          </p>
        ) : size ? (
          <div className="relative min-w-0 select-none">
            <canvas
              ref={baseCanvasRef}
              width={size.width}
              height={size.height}
              className="block h-auto max-h-[68vh] w-auto max-w-full rounded-md border border-border/70"
            />
            <canvas
              ref={overlayCanvasRef}
              width={size.width}
              height={size.height}
              aria-label={`Annotate ${image.name}`}
              className={cn(
                "absolute inset-0 size-full touch-none rounded-md",
                tool === "text" ? "cursor-text" : "cursor-crosshair",
              )}
              onPointerDown={startStroke}
              onPointerMove={moveStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
            />
            {textDraft ? (
              <textarea
                autoFocus
                aria-label="Annotation text"
                rows={1}
                value={textDraft.value}
                onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setTextDraft(null);
                  } else if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    commitTextDraft();
                  }
                }}
                className="field-sizing-content absolute min-w-16 resize-none overflow-hidden border border-dashed border-white/80 bg-black/20 p-0 font-semibold leading-tight outline-none"
                style={{
                  left: `${(textDraft.at.x / (size.width || 1)) * 100}%`,
                  top: `${(textDraft.at.y / (size.height || 1)) * 100}%`,
                  color,
                  fontSize: `${(scale?.text ?? 14) * textDraft.displayScale}px`,
                }}
              />
            ) : null}
          </div>
        ) : (
          <p className="py-12 text-sm text-muted-foreground">Loading image…</p>
        )}
      </div>
      <DialogFooter>
        {saveError ? (
          <p role="alert" className="me-auto self-center text-sm text-destructive-foreground">
            {saveError}
          </p>
        ) : crop ? (
          <p className="me-auto self-center text-xs text-muted-foreground">
            Cropped to {crop.width} × {crop.height}
          </p>
        ) : null}
        <DialogClose render={<Button variant="ghost-muted" />}>Cancel</DialogClose>
        <Button disabled={!source || saving} onClick={() => void save()}>
          {saving ? "Applying…" : "Apply"}
        </Button>
      </DialogFooter>
    </div>
  );
}

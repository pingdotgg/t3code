// Fork: a canvas that shows one static render of Kaluwa's backdrop art. It draws once per
// change of its inputs or a real change of its size (debounced), never per frame.
import { type CSSProperties, useEffect, useEffectEvent, useRef } from "react";

import horseMarkUrl from "../../../../../assets/local/kaluwa-horse-mark.png";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { renderBackdrop, type BackdropRenderRequest } from "./backdropRender";
import type { BackdropImageSettings, GeneratedArt } from "./backdropSettings";
import { uploadBitmap, type BackdropUpload } from "./backdropUploads";

export type BackdropCanvasSource =
  | { readonly kind: "generated"; readonly art: GeneratedArt }
  | {
      readonly kind: "upload";
      readonly upload: BackdropUpload;
      readonly settings: BackdropImageSettings;
    };

export type BackdropCanvasOptions = Omit<
  BackdropRenderRequest,
  "width" | "height" | "dpr" | "source"
>;

const RESIZE_DEBOUNCE_MS = 150;
const CHANGE_DEBOUNCE_MS = 40;
const MAX_DPR = 2;

let horse: Promise<ImageBitmap | null> | null = null;
function loadHorse() {
  horse ??= fetch(horseMarkUrl)
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob))
    .catch(() => null);
  return horse;
}

// Renders run one after another and yield between, so a gallery of thumbnails never
// holds the main thread for longer than one artwork.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(task);
  queue = run.catch(() => undefined);
  return run;
}

async function renderToBitmap(
  source: BackdropCanvasSource,
  options: BackdropCanvasOptions,
  width: number,
  height: number,
): Promise<ImageBitmap | null> {
  const [horseBitmap, image] = await Promise.all([
    loadHorse(),
    source.kind === "upload" ? uploadBitmap(source.upload) : null,
  ]);
  const canvas = renderBackdrop(
    {
      ...options,
      width,
      height,
      dpr: Math.min(MAX_DPR, window.devicePixelRatio || 1),
      source:
        source.kind === "generated"
          ? source
          : { kind: "image", bitmap: image!, settings: source.settings },
    },
    { horse: horseBitmap },
  );
  return canvas ? canvas.transferToImageBitmap() : null;
}

function sourceKey(source: BackdropCanvasSource) {
  return source.kind === "generated"
    ? source.art
    : `${source.upload.id}:${JSON.stringify(source.settings)}`;
}

export function BackdropCanvas({
  source,
  options,
  className,
  style,
}: {
  source: BackdropCanvasSource;
  options: BackdropCanvasOptions;
  className?: string;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const key = `${sourceKey(source)}|${JSON.stringify(options)}`;
  const render = useEffectEvent((width: number, height: number) =>
    enqueue(() => renderToBitmap(source, options, width, height)),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- draws into the canvas and follows its size while mounted
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("bitmaprenderer");
    if (!canvas || !context) return;
    // Names the inputs this canvas shows; a new key redraws it.
    canvas.dataset.backdrop = key;
    let drawn: { width: number; height: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const draw = (width: number, height: number) => {
      drawn = { width, height };
      void render(width, height).then(
        (bitmap) => {
          if (cancelled) bitmap?.close();
          else context.transferFromImageBitmap(bitmap);
        },
        (error: unknown) => console.error("[kaluwa-backdrop] Could not draw the backdrop.", error),
      );
    };
    const stop = observeResize(canvas, (entries) => {
      const { width, height } = entries.at(-1)!.contentRect;
      if (drawn && Math.abs(drawn.width - width) < 2 && Math.abs(drawn.height - height) < 2) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => draw(width, height),
        drawn ? RESIZE_DEBOUNCE_MS : CHANGE_DEBOUNCE_MS,
      );
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop();
    };
  }, [key]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("pointer-events-none block", className)}
      style={style}
    />
  );
}

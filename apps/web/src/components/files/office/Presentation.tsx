/* oxlint-disable react/no-unstable-nested-components -- These callbacks return overlays, and are invoked as render functions. */
import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  FileSurfaceAction,
  FileSurfaceLoading,
  FILE_SURFACE_SUBHEADER_CLASS,
} from "../fileSurfaceChrome";
import { OfficePages, type PaintPage } from "./OfficePages";
import { createWorkerClient } from "./worker-rpc";
import {
  maxImageSide,
  type SlideMethods,
  type SlideSummary,
  type VectorRequest,
} from "./slide-protocol";

type Opened = { slides: readonly SlideSummary[]; paint: PaintPage };
export default function Presentation(props: {
  bytes: ArrayBuffer;
  onDetails: (text: string) => void;
  onError: (cause: unknown) => void;
}) {
  const { onError, bytes: source, onDetails } = props;
  const [opened, setOpened] = useState<Opened>();
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const scroll = useRef<((index: number, y?: number) => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Open and paint slides through a worker whose requests and lifetime belong to this presentation.
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./presentation.worker.ts", import.meta.url), {
      type: "module",
    });
    const engine = createWorkerClient<SlideMethods>(worker);
    const fail = (cause: unknown) => {
      if (!controller.signal.aborted) onError(cause);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    const paint = async (
      index: number,
      canvas: HTMLCanvasElement,
      scale: number,
      signal: AbortSignal,
      again = false,
    ): Promise<void> => {
      const result = await engine.call(
        "paint",
        { index, density: (window.devicePixelRatio || 1) * scale },
        { key: `slide:${index}`, signal },
      );
      if (signal.aborted || result.kind === "cancelled") {
        if (result.kind === "painted") result.bitmap.close();
        return;
      }
      setFailed((previous) => ({ ...previous, [index]: result.kind === "failed" }));
      if (result.kind === "failed") return;
      const context = canvas.getContext("bitmaprenderer");
      if (!context) {
        result.bitmap.close();
        throw new Error("This browser cannot draw slides.");
      }
      canvas.width = result.bitmap.width;
      canvas.height = result.bitmap.height;
      context.transferFromImageBitmap(result.bitmap);
      if (again || !result.vectors.length) return;
      const bitmaps = await Promise.all(result.vectors.map(rasterize));
      if (signal.aborted) {
        bitmaps.forEach((value) => value.bitmap?.close());
        return;
      }
      await engine.call("vectors", bitmaps, {
        transfer: bitmaps.flatMap((value) => (value.bitmap ? [value.bitmap] : [])),
        signal,
      });
      if (!signal.aborted) await paint(index, canvas, scale, signal, true);
    };
    const bytes = source.slice(0);
    void engine
      .call("open", { bytes }, { transfer: [bytes], signal: controller.signal })
      .then((slides) => {
        if (slides.length === 0 || slides.length > 500)
          throw new Error("Preview limited to presentations with 1 to 500 slides.");
        setOpened({ slides, paint });
        onDetails(`${slides.length} slides`);
      })
      .catch(fail);
    return () => {
      controller.abort();
      engine.close();
    };
  }, [source, onDetails, onError]);
  if (!opened) return <FileSurfaceLoading />;
  const select = (index: number) => {
    setPage(index);
    scroll.current?.(index);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        <FileSurfaceAction
          label="Previous slide"
          disabled={page === 0}
          onPress={() => select(page - 1)}
        >
          <ChevronLeftIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="flex-1 text-center text-xs tabular-nums" aria-live="polite">
          Slide {page + 1} of {opened.slides.length}
        </span>
        <FileSurfaceAction
          label="Next slide"
          disabled={page + 1 === opened.slides.length}
          onPress={() => select(page + 1)}
        >
          <ChevronRightIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      <OfficePages
        pages={opened.slides}
        paint={opened.paint}
        label="Slide"
        scrollRef={scroll}
        onPageChange={setPage}
        onError={onError}
        overlay={(index) => (
          <>
            {opened.slides[index]?.hidden ? (
              <div className="pointer-events-none absolute inset-0 bg-white/50" />
            ) : null}
            {failed[index] ? (
              <p
                role="status"
                className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-xs text-foreground"
              >
                This slide could not be drawn.
              </p>
            ) : null}
          </>
        )}
        footer={(index) => {
          const slide = opened.slides[index];
          return slide?.notes || slide?.hidden ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {slide.hidden ? <p>Hidden slide</p> : null}
              {slide.notes ? (
                <p
                  role="note"
                  aria-label="Speaker notes"
                  className="select-text whitespace-pre-wrap break-words"
                >
                  {slide.notes}
                </p>
              ) : null}
            </div>
          ) : null;
        }}
      />
    </div>
  );
}
async function rasterize(request: VectorRequest) {
  const url = URL.createObjectURL(request.blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    const shrink = Math.min(1, maxImageSide / Math.max(image.naturalWidth, image.naturalHeight));
    const size = request.size ?? {
      width: Math.max(1, Math.round(image.naturalWidth * shrink)),
      height: Math.max(1, Math.round(image.naturalHeight * shrink)),
    };
    return {
      asset: request.asset,
      bitmap: await createImageBitmap(image, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: "high",
      }),
    };
  } catch {
    return { asset: request.asset, bitmap: undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

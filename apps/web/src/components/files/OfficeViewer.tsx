/* oxlint-disable react/no-array-index-key -- Spreadsheet rows and columns retain their source positions. */
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import VirtualTablePreview from "./VirtualTablePreview";

import { useTheme } from "~/hooks/useTheme";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { FileSurfaceAction, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeWorkerResult } from "./officePreviewProtocol";

type Workbook = Extract<OfficeWorkerResult, { type: "xlsx" }>;
type Slide = Extract<OfficeWorkerResult, { type: "slide" }>;

const OFFICE_PAGE_PADDING = 20;
const OFFICE_PAGE_BACKGROUND = { light: "#f4f4f5", dark: "#141414" };

async function readOfficeFile(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("The file could not be loaded. Close it and try again.");
  if (Number(response.headers.get("content-length")) > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file is unavailable.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > OFFICE_PREVIEW_MAX_BYTES) throw new Error("Preview limited to files under 50 MB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}

async function renderWord(
  result: Extract<OfficeWorkerResult, { type: "docx" }>,
  signal: AbortSignal,
) {
  const [{ renderAsync }, { default: JSZip }, { default: DOMPurify }] = await Promise.all([
    import("docx-preview"),
    import("jszip"),
    import("dompurify"),
  ]);
  const archive = await JSZip.loadAsync(result.bytes);
  const html: string[] = [];
  const css = new Set<string>();
  for (const document of result.documents) {
    signal.throwIfAborted();
    // Worker batches end at body-level boundaries. Yield between batches so
    // parsing and sanitizing a long report cannot monopolize the UI thread.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const doc = window.document.implementation.createHTMLDocument();
    const body = doc.createElement("div");
    const styles = doc.createElement("div");
    archive.file("word/document.xml", document);
    await renderAsync(await archive.generateAsync({ type: "arraybuffer" }), body, styles, {
      ignoreFonts: true,
      useBase64URL: true,
      renderAltChunks: false,
      renderFootnotes: true,
      renderEndnotes: true,
      renderHeaders: true,
      renderFooters: true,
      renderComments: true,
      renderChanges: false,
      experimental: false,
    });
    const markup = DOMPurify.sanitize(body.innerHTML, {
      FORBID_TAGS: ["style", "a", "form", "input", "button", "video", "audio", "svg", "math"],
      FORBID_ATTR: ["srcset"],
    });
    const clean = new DOMParser().parseFromString(markup, "text/html");
    for (const image of clean.images) {
      if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(image.src)) image.remove();
    }
    // docx-preview uses an emoji that may be absent from the client's fonts.
    for (const marker of clean.querySelectorAll(".docx-comment-ref")) {
      marker.textContent = "";
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", "Comment");
    }
    html.push(clean.body.innerHTML);
    for (const style of styles.querySelectorAll("style")) css.add(style.textContent);
  }
  return {
    html: html.join(""),
    css: [...css].join("\n").replaceAll(/<\/style/gi, ""),
    truncated: result.truncated,
  };
}

function WordFrame(props: {
  readonly content: { html: string; css: string; truncated: boolean };
  readonly name: string;
}) {
  const { resolvedTheme } = useTheme();
  // HTML reparsing moves block comment popovers out of their source paragraph.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${props.content.css}</style><style>html{background:${OFFICE_PAGE_BACKGROUND[resolvedTheme]}}body{margin:0}.docx-wrapper{background:transparent;padding:${OFFICE_PAGE_PADDING}px;box-sizing:border-box}.docx-wrapper section.docx{width:612pt;max-width:100%;box-sizing:border-box;padding:32px!important;min-height:0!important}img{max-width:100%;height:auto}.docx-wrapper section.docx div{max-width:100%}img{height:auto!important}.docx-comment-ref{display:inline-block;position:relative;width:.75em;height:.6em;margin-left:.25em;border:1px solid currentColor;border-radius:.12em;vertical-align:baseline}.docx-comment-ref::after{content:"";position:absolute;bottom:-.25em;left:.12em;width:.2em;height:.2em;border-left:1px solid currentColor;transform:skewY(-35deg)}.docx p:has(.docx-comment-ref:hover)+.docx-comment-popover{display:block}*{scrollbar-width:thin}</style></head><body>${props.content.html}</body></html>`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.content.truncated ? (
        <FileSurfaceNotice>
          Preview limited. Save it or open it in another app to read the full document.
        </FileSurfaceNotice>
      ) : null}
      <iframe title={props.name} srcDoc={srcDoc} sandbox="" className="min-h-0 flex-1 border-0" />
    </div>
  );
}

const loadSlidePainter = () => import("@betteroffice/pptx");

function SlideCanvas(props: {
  readonly slide: Slide;
  readonly onError: (message: string) => void;
}) {
  const { slide, onError } = props;
  const { resolvedTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const images: ImageBitmap[] = [];
    void (async () => {
      const { paintSlide } = await loadSlidePainter();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot render slides.");
      const frame = slide.frame;
      const scale = Math.min(2, 1920 / frame.width, 1080 / frame.height);
      canvas.width = Math.ceil(frame.width * scale);
      canvas.height = Math.ceil(frame.height * scale);
      const decoded = new Map<string, ImageBitmap>();
      for (const image of slide.images) {
        // createImageBitmap decodes raster data without document markup or URLs.
        const bitmap = await createImageBitmap(new Blob([image.bytes])).catch(() => null);
        if (bitmap) {
          images.push(bitmap);
          decoded.set(image.id, bitmap);
        }
      }
      if (!cancelled)
        await paintSlide(context, frame, 1, scale, {
          resolveImage: (id) => decoded.get(id) ?? null,
          maxShadowPixels: canvas.width * canvas.height * 4,
        });
    })()
      .catch((cause: unknown) => {
        if (!cancelled)
          onError(cause instanceof Error ? cause.message : "Could not render this slide.");
      })
      .finally(() => {
        for (const image of images) image.close();
      });
    return () => {
      cancelled = true;
    };
  }, [slide, onError]);
  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      style={{ background: OFFICE_PAGE_BACKGROUND[resolvedTheme], padding: OFFICE_PAGE_PADDING }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={props.slide.text || `Slide ${props.slide.index + 1}`}
        className="block h-auto w-full shadow-sm"
      />
    </div>
  );
}

export default function OfficeViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: OfficePreviewKind;
  readonly sizeBytes?: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [word, setWord] = useState<Awaited<ReturnType<typeof renderWord>> | null>(null);
  const [sheetPages, setSheetPages] = useState(new Map<string, string[][]>());
  const pendingPages = useRef(new Set<string>());
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [slide, setSlide] = useState<Slide | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let loadedFont: FontFace | null = null;
    if ((props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
      // oxlint-disable-next-line react/set-state-in-effect -- The file metadata can reject the preview before loading bytes or engines.
      setError("Preview limited to files under 50 MB.");
      return;
    }
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const fail = (message: string) => {
      if (!controller.signal.aborted) setError(message);
      controller.abort();
      worker.terminate();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    timerRef.current = setTimeout(
      () => fail("This document took too long to preview. Open it in another app."),
      30_000,
    );
    worker.addEventListener("error", () =>
      fail("Could not load the Office viewer. Close the file and try again."),
    );
    worker.addEventListener("message", (event: MessageEvent<OfficeWorkerResult>) => {
      if (controller.signal.aborted) return;
      const result = event.data;
      if (result.type === "error") fail(result.message);
      else if (result.type === "docx") {
        void renderWord(result, controller.signal)
          .then((content) => {
            if (!controller.signal.aborted) {
              if (timerRef.current) clearTimeout(timerRef.current);
              setWord(content);
            }
          })
          .catch(() => fail("This Word document could not be parsed."));
      } else if (result.type === "xlsx") {
        if (timerRef.current) clearTimeout(timerRef.current);
        setWorkbook(result);
        setCount(result.sheets.length);
      } else if (result.type === "sheet-page") {
        const key = `${result.sheet}:${result.index}`;
        pendingPages.current.delete(key);
        setSheetPages((old) => {
          const next = new Map(old);
          next.set(key, result.rows);
          if (next.size > 12) next.delete(next.keys().next().value!);
          return next;
        });
      } else if (result.type === "pptx") {
        void new FontFace("Carlito", result.font)
          .load()
          .then((font) => {
            if (controller.signal.aborted) return;
            loadedFont = font;
            document.fonts.add(font);
            setCount(result.count);
            worker.postMessage({ type: "slide", index: 0 }, []);
          })
          .catch(() => fail("Could not load the presentation font."));
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        setSlide(result);
      }
    });
    void readOfficeFile(props.src, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted)
          worker.postMessage({ type: "open", kind: props.kind, bytes }, [bytes]);
      })
      .catch((cause: unknown) =>
        fail(cause instanceof Error ? cause.message : "Could not read this file."),
      );
    return () => {
      controller.abort();
      if (loadedFont) document.fonts.delete(loadedFont);
      worker.terminate();
      workerRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [props.src, props.kind, props.sizeBytes]);
  const selectPage = (index: number) => {
    setPage(index);
    if (props.kind !== "pptx") return;
    setSlide(null);
    workerRef.current?.postMessage({ type: "slide", index }, []);
    timerRef.current = setTimeout(() => {
      setError("This slide took too long to preview.");
      workerRef.current?.terminate();
    }, 30_000);
  };
  if (error)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-sm font-medium">No preview for this file</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {error} Save it or open it in another app.
        </p>
      </div>
    );
  if (word) return <WordFrame content={word} name={props.name} />;
  const sheet = workbook?.sheets[page];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {count > 0 ? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
          <FileSurfaceAction
            label={workbook ? "Previous sheet" : "Previous slide"}
            disabled={page === 0 || (props.kind === "pptx" && slide === null)}
            onPress={() => selectPage(page - 1)}
          >
            <ChevronLeftIcon className="size-3.5" />
          </FileSurfaceAction>
          {workbook ? (
            <div className="min-w-0 flex-1">
              <Select
                value={page}
                onValueChange={(value) => {
                  if (value !== null) selectPage(value);
                }}
              >
                <SelectTrigger aria-label="Sheet" size="xs">
                  <SelectValue>{sheet?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {workbook.sheets.map((item, index) => (
                    <SelectItem key={index} value={index}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : (
            <span className="flex-1 text-center tabular-nums" aria-live="polite">
              Slide {page + 1} of {count}
            </span>
          )}
          <FileSurfaceAction
            label={workbook ? "Next sheet" : "Next slide"}
            disabled={page + 1 === count || (props.kind === "pptx" && slide === null)}
            onPress={() => selectPage(page + 1)}
          >
            <ChevronRightIcon className="size-3.5" />
          </FileSurfaceAction>
        </div>
      ) : null}
      {sheet ? (
        <>
          <FileSurfaceNotice>
            Cell values only. Charts, images, and formatting are not shown.
            {sheet.truncated
              ? " Preview limited to 250,000 rows, 1,024 columns, and bounded cell text."
              : ""}
          </FileSurfaceNotice>
          {sheet.rowCount === 0 ? (
            <p className="p-6 text-xs text-muted-foreground">This sheet is empty.</p>
          ) : (
            <VirtualTablePreview
              key={page}
              name={`${props.name}: ${sheet.name}`}
              count={sheet.rowCount}
              columns={sheet.columns}
              getRows={(index) => (index === 0 ? sheet.rows : sheetPages.get(`${page}:${index}`))}
              loadPage={(index) => {
                const key = `${page}:${index}`;
                if (pendingPages.current.has(key)) return;
                pendingPages.current.add(key);
                workerRef.current?.postMessage({ type: "sheet-page", sheet: page, index });
              }}
            />
          )}
        </>
      ) : slide ? (
        <SlideCanvas slide={slide} onError={setError} />
      ) : (
        <FileSurfaceLoading />
      )}
    </div>
  );
}

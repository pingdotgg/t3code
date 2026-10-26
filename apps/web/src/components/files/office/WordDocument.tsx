/* oxlint-disable react/no-array-index-key -- Text spans retain their order within an immutable page. */
/* oxlint-disable react/no-unstable-nested-components -- These callbacks return overlays, and are invoked as render functions. */
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { Fragment, useEffect, useRef, useState } from "react";
import { FileSurfaceLoading } from "../fileSurfaceChrome";
import { OfficePages, type PaintPage } from "./OfficePages";
import { createWorkerClient } from "./worker-rpc";
import {
  layerFont,
  lineHeight,
  type WordMethods,
  type WordPageSize,
  type WordSpan,
  type WordLink,
} from "./word-protocol";

type Opened = {
  pages: readonly WordPageSize[];
  paint: PaintPage;
  engine: ReturnType<typeof createWorkerClient<WordMethods>>;
};

export default function WordDocument(props: {
  bytes: ArrayBuffer;
  onDetails: (text: string) => void;
  onError: (cause: unknown) => void;
}) {
  const { onError, bytes, onDetails } = props;
  const [opened, setOpened] = useState<Opened>();
  const scroll = useRef<((index: number, y?: number) => void) | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Own the document worker and cancel its layout and painting requests when the document changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./document.worker.ts", import.meta.url), { type: "module" });
    const engine = createWorkerClient<WordMethods>(worker);
    const fail = (error: unknown) => {
      if (!controller.signal.aborted) onError(error);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    const buffer = bytes.slice(0);
    const paint: PaintPage = async (index, canvas, scale, signal) => {
      const bitmap = await engine.call(
        "paint",
        { index, scale, ratio: window.devicePixelRatio || 1 },
        { key: `paint:${index}`, signal },
      );
      void engine
        .call("build", { index: index + 1 }, { key: "build", signal })
        .catch(() => undefined);
      if (!bitmap) return;
      const context = canvas.getContext("bitmaprenderer");
      if (!context || signal.aborted) {
        bitmap.close();
        return;
      }
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      context.transferFromImageBitmap(bitmap);
    };
    void engine
      .call("open", { bytes: buffer }, { transfer: [buffer], signal: controller.signal })
      .then(async (first) => {
        if (controller.signal.aborted) return;
        setOpened({ pages: first.pages, paint, engine });
        onDetails(`${first.pages.length}${first.loading ? "+" : ""} pages`);
        if (!first.loading) return;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        while (!controller.signal.aborted) {
          const step = await engine.call("layout", undefined, { signal: controller.signal });
          if (!step.done) continue;
          if (step.pages.length > 1000) throw new Error("Preview limited to 1,000 pages.");
          setOpened({ pages: step.pages, paint, engine });
          onDetails(`${step.pages.length} pages`);
          break;
        }
      })
      .catch(fail);
    return () => {
      controller.abort();
      engine.close();
    };
  }, [bytes, onDetails, onError]);
  if (!opened) return <FileSurfaceLoading />;
  const follow = (link: WordLink) => {
    if (link.kind === "external") {
      window.open(link.url, "_blank", "noopener,noreferrer");
      return;
    }
    void opened.engine
      .call("bookmark", { name: link.bookmark })
      .then((target) => {
        if (target) scroll.current?.(target.index, target.y);
      })
      .catch(onError);
  };
  return (
    <OfficePages
      pages={opened.pages}
      paint={opened.paint}
      label="Page"
      scrollRef={scroll}
      onError={onError}
      overlay={(index) => (
        <WordTextLayer
          engine={opened.engine}
          index={index}
          page={opened.pages[index]}
          follow={follow}
        />
      )}
    />
  );
}

function WordTextLayer(props: {
  engine: Opened["engine"];
  index: number;
  page: WordPageSize | undefined;
  follow: (link: WordLink) => void;
}) {
  const { engine, index, page, follow } = props;
  const [spans, setSpans] = useState<readonly WordSpan[]>([]);
  // oxlint-disable-next-line t3code/react-effect-budget -- Request selectable text from the document worker and cancel the request when its page leaves the viewport.
  useEffect(() => {
    if (!page) return;
    const controller = new AbortController();
    void engine
      .call("text", { index: index }, { signal: controller.signal })
      .then(setSpans)
      .catch(() => undefined);
    return () => controller.abort();
  }, [engine, index, page]);
  return (
    <div
      className="absolute inset-0 select-text overflow-hidden whitespace-pre text-transparent selection:bg-primary/30 selection:text-transparent"
      style={{ containerType: "inline-size", fontFamily: layerFont, fontSize: 0, lineHeight }}
    >
      {spans.map((span, index) => {
        const text = (
          <span
            dir={span.dir}
            role={span.link ? "link" : undefined}
            tabIndex={span.link ? 0 : undefined}
            aria-label={span.title}
            className="absolute origin-top-left"
            style={{
              left: `${span.left * 100}%`,
              top: `${span.top * 100}%`,
              fontSize: `${span.size * 100}cqw`,
              transform: span.transform,
              cursor: span.link ? "pointer" : "text",
            }}
            onClick={(event) => {
              if (span.link && event.button === 0 && (getSelection()?.isCollapsed ?? true))
                follow(span.link);
            }}
            onKeyDown={(event) => {
              if (span.link && event.key === "Enter") {
                event.preventDefault();
                follow(span.link);
              }
            }}
          >
            {span.text}
          </span>
        );
        return (
          <Fragment key={index}>
            {span.title ? (
              <Tooltip>
                <TooltipTrigger render={text} />
                <TooltipPopup>{span.title}</TooltipPopup>
              </Tooltip>
            ) : (
              text
            )}
            {span.after === "br" ? <br /> : span.after === "tab" ? "\t" : null}
          </Fragment>
        );
      })}
    </div>
  );
}

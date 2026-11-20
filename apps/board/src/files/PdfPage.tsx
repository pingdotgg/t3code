import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useState } from "react";

/** The width pages are drawn at. The canvas scales to the panel, so a page stays sharp up to this wide. */
const PAGE_PX = 960;

/** One page, drawn when it scrolls into view and drawn no more than once. */
export function PdfPage({ document, index }: { document: PDFDocumentProxy; index: number }) {
  const [ratio, setRatio] = useState(1.3);
  const draw = useCallback(
    (frame: HTMLDivElement) => {
      const canvas = frame.querySelector("canvas");
      let cancelled = false;
      let render: { cancel: () => void } | undefined;
      const observer = new IntersectionObserver(
        async (entries) => {
          if (!entries.some((entry) => entry.isIntersecting) || canvas === null) return;
          observer.disconnect();
          const page = await document.getPage(index + 1);
          const natural = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: PAGE_PX / natural.width });
          if (cancelled) return;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          setRatio(viewport.height / viewport.width);
          const task = page.render({ canvas, viewport, background: "white" });
          render = task;
          await task.promise.catch(() => undefined);
          page.cleanup();
        },
        { rootMargin: "400px" },
      );
      observer.observe(frame);
      return () => {
        cancelled = true;
        observer.disconnect();
        render?.cancel();
      };
    },
    [document, index],
  );
  return (
    <div
      ref={draw}
      data-testid="pdf-page"
      style={{ aspectRatio: `1 / ${ratio}` }}
      className="w-full bg-white"
    >
      <canvas aria-label={`Page ${index + 1}`} className="block size-full" />
    </div>
  );
}

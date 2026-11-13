import { isHeifImage, needsImageDecoder } from "./AttachmentImage";
import { readMediaBlob } from "./mediaContent";

// Desktop has no PDF plugin to print with, so PDFs print as pages PDF.js renders,
// at the 150 DPI its own viewer prints at.
const PDF_PRINT_SCALE = 150 / 72;
const PDF_PRINT_MAX_PIXELS = 16 * 1024 * 1024;
const PDF_PRINT_MAX_PAGES = 200;

// A new print supersedes one that is still preparing or waiting for its dialog.
let activeJob: AbortController | null = null;

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("A PDF page could not be prepared."))),
      "image/png",
    );
  });
}

async function renderPdfPages(blob: Blob, signal: AbortSignal) {
  const { openPdf } = await import("../files/pdfDocument");
  const task = openPdf(await blob.arrayBuffer());
  const pages: { blob: Blob; width: number; height: number }[] = [];
  try {
    const pdf = await task.promise;
    if (pdf.numPages > PDF_PRINT_MAX_PAGES) {
      throw new Error(
        `Printing is limited to ${PDF_PRINT_MAX_PAGES} pages. Save the PDF to print it in full.`,
      );
    }
    for (let number = 1; number <= pdf.numPages; number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      // PDF units are points, so each page's size maps straight to CSS.
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(
          PDF_PRINT_SCALE,
          Math.sqrt(PDF_PRINT_MAX_PIXELS / (natural.width * natural.height)),
        ),
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: "white", intent: "print" }).promise;
      page.cleanup();
      pages.push({ blob: await canvasPng(canvas), width: natural.width, height: natural.height });
    }
    return pages;
  } finally {
    void task.destroy();
  }
}

async function decodeForPrint(blob: Blob, name: string, signal: AbortSignal) {
  if (!needsImageDecoder(name, blob.type)) return blob;
  const { decodeImagePreview } = await import("../files/decodeImagePreview");
  const url = URL.createObjectURL(blob);
  try {
    return await decodeImagePreview(url, isHeifImage(name, blob.type), signal);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function printPages(
  title: string,
  pages: readonly Blob[],
  pageStyle: (first: HTMLImageElement) => string,
  job: AbortController,
): Promise<void> {
  const { signal } = job;
  const urls = pages.map((page) => URL.createObjectURL(page));
  const frame = document.createElement("iframe");
  signal.addEventListener(
    "abort",
    () => {
      frame.remove();
      for (const url of urls) URL.revokeObjectURL(url);
    },
    { once: true },
  );
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Hidden but laid out: some browsers skip printing a display:none frame.
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";
  await new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    signal.addEventListener("abort", () => resolve(), { once: true });
    document.body.append(frame);
  });
  signal.throwIfAborted();
  const printDocument = frame.contentDocument;
  const printWindow = frame.contentWindow;
  if (!printDocument || !printWindow) throw new Error("Printing is unavailable in this window.");
  // The title names the print job and the default file name for Save as PDF.
  printDocument.title = title;
  const images = urls.map((url) => {
    const image = printDocument.createElement("img");
    image.alt = "";
    image.src = url;
    return image;
  });
  printDocument.body.append(...images);
  await Promise.all(images.map((image) => image.decode())).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw new Error("The browser could not decode this image for printing. Try saving it.", {
      cause,
    });
  });
  signal.throwIfAborted();
  const style = printDocument.createElement("style");
  style.textContent = `html,body{margin:0}img{display:block}img+img{break-before:page}${pageStyle(images[0]!)}`;
  printDocument.head.append(style);
  printWindow.addEventListener("afterprint", () => job.abort(), { once: true });
  printWindow.print();
}

/** Prints an image or PDF from its URL through the browser's print dialog. */
export async function printMedia(src: string, title: string, kind: "image" | "pdf") {
  activeJob?.abort();
  const job = new AbortController();
  activeJob = job;
  job.signal.addEventListener(
    "abort",
    () => {
      if (activeJob === job) activeJob = null;
    },
    { once: true },
  );
  try {
    const blob = await readMediaBlob(src);
    job.signal.throwIfAborted();
    if (kind === "pdf") {
      const pages = await renderPdfPages(blob, job.signal);
      // Each PDF page keeps its own size and orientation through a named page.
      await printPages(
        title,
        pages.map((page) => page.blob),
        () =>
          pages
            .map(
              ({ width, height }, index) =>
                `@page p${index}{size:${width}pt ${height}pt;margin:0}img:nth-of-type(${index + 1}){page:p${index};width:${width}pt;height:${height}pt}`,
            )
            .join(""),
        job,
      );
      return;
    }
    // Fit the image to the page in whichever orientation wastes less paper.
    await printPages(
      title,
      [await decodeForPrint(blob, title, job.signal)],
      (image) =>
        `@page{size:${image.naturalWidth > image.naturalHeight ? "landscape" : "portrait"};margin:0}html,body{height:100%}body{box-sizing:border-box;padding:0.4in}img{width:100%;height:100%;object-fit:contain}`,
      job,
    );
  } catch (cause) {
    // A newer print replaced this one, so there is nothing to report.
    if (job.signal.aborted) return;
    job.abort();
    throw cause;
  }
}

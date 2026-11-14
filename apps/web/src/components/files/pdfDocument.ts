import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, PDFWorker } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import fallbackUrl from "pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const standardFonts = import.meta.glob<string>(
  "../../../node_modules/pdfjs-dist/standard_fonts/*",
  { query: "?url", import: "default", eager: true },
);
const cMaps = import.meta.glob<string>("../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  query: "?url",
  import: "default",
  eager: true,
});
const wasm = import.meta.glob<string>("../../../node_modules/pdfjs-dist/wasm/*.{wasm,js}", {
  query: "?url",
  import: "default",
  eager: true,
});
export class BinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const assets = kind === "cMapUrl" ? cMaps : kind === "wasmUrl" ? wasm : standardFonts;
    const directory = kind === "cMapUrl" ? "cmaps" : kind === "wasmUrl" ? "wasm" : "standard_fonts";
    const url = assets[`../../../node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!url) throw new Error(`Unsupported PDF ${directory} asset.`);
    const response = await fetch(url);
    if (!response.ok || response.headers.get("content-type")?.startsWith("text/html"))
      throw new Error(`PDF ${directory} asset unavailable.`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

// Without a shared worker, pdf.js starts a worker and recompiles its 1.3 MB script for every document.
let worker: PDFWorker | undefined;

const RANGE_CHUNK_BYTES = 64 * 1024;

async function readRange(src: string, begin: number, end: number, signal: AbortSignal) {
  const response = await fetch(src, {
    signal,
    // A cached partial response makes the browser add If-Range, which the server answers in full.
    cache: "no-store",
    // Explicit offsets stay CORS-safelisted; suffix ranges need a preflight the server refuses.
    headers: { range: `bytes=${begin}-${end - 1}` },
  });
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  const size = Number(match?.[3]);
  const bytes = response.status === 206 && match ? await response.arrayBuffer() : null;
  if (
    !bytes ||
    Number(match![1]) !== begin ||
    Number(match![2]) !== Math.min(end, size) - 1 ||
    bytes.byteLength !== Math.min(end, size) - begin
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid PDF range response.");
  }
  return { bytes: new Uint8Array(bytes), size, revision: response.headers.get("etag") };
}

/**
 * Reads only the byte ranges PDF.js asks for. Resolves null when the source cannot
 * serve validated ranges; `onFailure` reports a later bad range or revision change.
 */
export async function openPdfRanges(
  src: string,
  signal: AbortSignal,
  limit: number,
  onFailure: () => void,
) {
  const first = await readRange(src, 0, RANGE_CHUNK_BYTES, signal).catch(() => null);
  if (!first?.revision) return null;
  if (first.size > limit) throw new Error("This file is too large to preview.");
  const transport = new PDFDataRangeTransport(first.size, first.bytes);
  transport.requestDataRange = (begin: number, end: number) => {
    void readRange(src, begin, end, signal)
      .then((range) => {
        if (range.size !== first.size || range.revision !== first.revision)
          throw new Error("The PDF changed while loading.");
        transport.onDataRange(begin, range.bytes);
      })
      .catch(() => {
        if (!signal.aborted) onFailure();
      });
  };
  return transport;
}

export function openPdf(source: ArrayBuffer | PDFDataRangeTransport) {
  worker ??= new PDFWorker();
  return getDocument({
    worker,
    ...(source instanceof ArrayBuffer
      ? { data: new Uint8Array(source) }
      : { range: source, rangeChunkSize: RANGE_CHUNK_BYTES, disableAutoFetch: true }),
    useSystemFonts: true,
    useWorkerFetch: false,
    BinaryDataFactory,
    // PDF.js imports JavaScript decoders directly, bypassing BinaryDataFactory.
    wasmUrl: new URL(".", new URL(fallbackUrl, window.location.href)).href,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    useWasm: true,
  });
}

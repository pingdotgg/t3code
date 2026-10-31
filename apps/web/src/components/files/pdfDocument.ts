import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
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

export function openPdf(bytes: ArrayBuffer) {
  return getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    useWorkerFetch: false,
    BinaryDataFactory,
    // PDF.js imports JavaScript decoders directly, bypassing BinaryDataFactory.
    wasmUrl: new URL(".", new URL(fallbackUrl, window.location.href)).href,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    useWasm: true,
  });
}

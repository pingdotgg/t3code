/**
 * Design file import for the canvas: `.pen` (pencil.dev JSON), `.fig`
 * (Figma binary, bare or zipped), and `.zip` snapshots holding any of those
 * plus image assets. Pure: runs in the browser and in Node. Never throws on
 * a partial file; anything skipped is reported in `warnings`.
 */
import { unzipSync } from "fflate";

import {
  baseName,
  type CanvasImportResult,
  ImportBuilder,
  layoutSideBySide,
  wrapRootsInFrame,
} from "./common.ts";
import { decodeFigKiwi, importFigMessage, isFigKiwi } from "./fig.ts";
import { IMAGE_EXTENSIONS, extensionOf, unsupportedCanvasFileMessage } from "./formats.ts";
import { importImage } from "./image.ts";
import { DecodeBudget } from "./limits.ts";
import { importPenDocument, parsePenJson } from "./pen.ts";

export type { CanvasImportResult } from "./common.ts";

const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Image bytes from `images/<hash>` entries, keyed by bare hash, as `.fig` paints reference them. */
function figImages(files: Record<string, Uint8Array>, prefix: string): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith(`${prefix}images/`)) continue;
    const name = path.slice(prefix.length + "images/".length);
    if (name && !name.includes("/")) images.set(name.toLowerCase(), bytes);
  }
  return images;
}

function importFigBytes(
  builder: ImportBuilder,
  bytes: Uint8Array,
  images: Map<string, Uint8Array>,
  budget: DecodeBudget,
) {
  importFigMessage(builder, decodeFigKiwi(bytes, budget), images);
}

/** Unzips entries, charging their declared sizes (fflate never writes past them) to the budget. */
function unzipWithin(
  bytes: Uint8Array,
  budget: DecodeBudget,
  keep: (name: string) => boolean = () => true,
): Record<string, Uint8Array> {
  return unzipSync(bytes, {
    filter: (file) => {
      if (!keep(file.name)) return false;
      budget.take(file.compression === 0 ? file.size : file.originalSize);
      return true;
    },
  });
}

/**
 * A zip is either a Figma download (`canvas.fig` + `images/`) or a snapshot
 * holding one or more `.pen` / `.fig` / `.json` documents plus assets. Each
 * document becomes top-level frames; documents sit side by side.
 */
async function importZip(
  builder: ImportBuilder,
  fileName: string,
  bytes: Uint8Array,
  budget: DecodeBudget,
): Promise<void> {
  const files = unzipWithin(
    bytes,
    budget,
    (name) => !name.endsWith("/") && !name.startsWith("__MACOSX/"),
  );
  const paths = Object.keys(files).sort();

  // A Figma download: canvas.fig at the root (or under one folder).
  const canvasFig = paths.find(
    (path) => /(^|\/)canvas\.(?:fig|figma)$/.test(path) && path.split("/").length <= 2,
  );
  const documents = paths.filter((path) => {
    const extension = extensionOf(path);
    if (path === canvasFig) return true;
    if (extension === "pen" || extension === "fig" || extension === "figma") return true;
    return (
      extension === "json" && !/(^|\/)meta\.json$/.test(path) && !/(^|\/)package\.json$/.test(path)
    );
  });
  // Asset-only exports become image layers without duplicating document assets.
  if (documents.length === 0)
    documents.push(...paths.filter((path) => IMAGE_EXTENSIONS.has(extensionOf(path))));
  if (documents.length === 0) {
    builder.warn(`${fileName} has no .pen, .fig, .figma, .json, SVG, or supported image documents`);
    return;
  }

  const firstRoot = builder.rootIds.length;
  for (const path of documents) {
    const docStart = builder.rootIds.length;
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const data = files[path]!;
    try {
      if (IMAGE_EXTENSIONS.has(extensionOf(path))) {
        importImage(builder, path, data);
      } else if (isFigKiwi(data)) {
        importFigBytes(builder, data, figImages(files, directory), budget);
      } else if (isZip(data)) {
        const inner = unzipWithin(data, budget);
        const innerCanvas = inner["canvas.fig"] ?? inner["canvas.figma"];
        if (!innerCanvas) throw new Error("zipped .fig has no canvas.fig");
        importFigBytes(builder, innerCanvas, figImages(inner, ""), budget);
      } else {
        const document = parsePenJson(new TextDecoder().decode(data));
        await importPenDocument(builder, document, (url) => resolveZipAsset(files, directory, url));
        // A snapshot document becomes one frame so documents do not overlap.
        if (documents.length > 1) {
          wrapRootsInFrame(builder, docStart, { type: "frame", name: baseName(path) });
        }
      }
    } catch (error) {
      builder.warn(`Skipped ${path}: ${errorMessage(error)}`);
    }
  }
  if (documents.length > 1) layoutSideBySide(builder, builder.rootIds.slice(firstRoot));
}

/** Resolves a document-relative asset URL against the zip's entries. */
function resolveZipAsset(
  files: Record<string, Uint8Array>,
  directory: string,
  url: string,
): Uint8Array | null {
  if (/^[a-z]+:/i.test(url)) return null;
  const segments = `${directory}${url.replace(/^\.\//, "")}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== "." && segment !== "") resolved.push(segment);
  }
  const path = resolved.join("/");
  const exact = files[path];
  if (exact) return exact;
  // Fall back to a unique file name match anywhere in the archive.
  const leaf = resolved.at(-1);
  if (!leaf) return null;
  const matches = Object.keys(files).filter((candidate) => candidate.split("/").pop() === leaf);
  return matches.length === 1 ? files[matches[0]!]! : null;
}

export async function importCanvasFile(
  fileName: string,
  bytes: Uint8Array,
): Promise<CanvasImportResult> {
  const builder = new ImportBuilder();
  const budget = new DecodeBudget();
  const name = baseName(fileName) || "Imported design";
  try {
    const unsupported = unsupportedCanvasFileMessage(fileName);
    if (unsupported) throw new Error(unsupported);
    if (IMAGE_EXTENSIONS.has(extensionOf(fileName))) {
      importImage(builder, fileName, bytes);
    } else if (isZip(bytes)) {
      await importZip(builder, fileName, bytes, budget);
    } else if (isFigKiwi(bytes)) {
      importFigBytes(builder, bytes, new Map(), budget);
    } else {
      const extension = extensionOf(fileName);
      if (extension === "fig" || extension === "figma")
        throw new Error("not a Figma file (missing fig-kiwi header)");
      const document = parsePenJson(new TextDecoder().decode(bytes));
      await importPenDocument(builder, document, () => null);
    }
  } catch (error) {
    builder.warn(`Could not import ${fileName}: ${errorMessage(error)}`);
  }
  return builder.result(name);
}

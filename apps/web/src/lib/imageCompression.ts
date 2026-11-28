import { loadHeicDecoder } from "./heicDecoder";
import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
  IMAGE_ATTACHMENT_MAX_EDGE,
} from "@t3tools/client-runtime/image-attachment-size";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import {
  createCanvas,
  type EncodeCanvas,
  encodeCanvasOnThisThread,
  fitImageToMaxEdge,
  iccProfileIsDisplayP3,
  type ImageSize,
  MAX_IMAGE_METADATA_BYTES,
  readImageColorSpace,
  renderThumbnail,
  renderThumbnailFromBitmap,
} from "./imageCanvas";
import type {
  ImageWorkerResponse,
  ImageWorkerResults,
  ImageWorkerTask,
} from "./imageCompression.worker";

const MAX_DIMENSION = IMAGE_ATTACHMENT_MAX_EDGE;
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000;
/** Bound source decoding: enormous ImageBitmaps can OOM the tab before resizing. */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;

export interface CompressedStashImage {
  imageSize?: ImageSize;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  recompressed: boolean;
}

export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type CompressStashImageResult =
  | { ok: true; image: CompressedStashImage }
  | { ok: false; reason: ImageCompressionFailureReason };

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean; imageSize?: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: Pick<File, "name" | "type">): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) {
    return true;
  }
  return (
    (file.type === "" || file.type.toLowerCase() === "application/octet-stream") &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

interface HeicMetadataBox {
  payloadOffset: number;
  endOffset: number;
}

function findHeicMetadataBox(
  view: DataView,
  startOffset: number,
  endOffset: number,
  type: number,
): HeicMetadataBox | null {
  let offset = startOffset;
  while (offset + 8 <= endOffset) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > endOffset) return null;
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = endOffset - offset;
    }
    if (size < headerSize || size > endOffset - offset) return null;

    const nextOffset = offset + size;
    if (view.getUint32(offset + 4) === type) {
      return { payloadOffset: offset + headerSize, endOffset: nextOffset };
    }
    offset = nextOffset;
  }
  return null;
}

/** `colr` is an nclx code point (12 is Display P3) or an embedded ICC profile. */
function heicColorIsDisplayP3(view: DataView, box: HeicMetadataBox): boolean {
  if (box.payloadOffset + 6 > box.endOffset) return false;
  const colorType = view.getUint32(box.payloadOffset);
  if (colorType === 0x6e636c78) return view.getUint16(box.payloadOffset + 4) === 12;
  if (colorType === 0x70726f66 || colorType === 0x72494343) {
    return iccProfileIsDisplayP3(view, box.payloadOffset + 4, box.endOffset);
  }
  return false;
}

type HeicMetadataResult =
  | { ok: true; displayP3: boolean }
  | { ok: false; reason: ImageCompressionFailureReason };

async function readHeicMetadata(file: File): Promise<HeicMetadataResult> {
  const unreadable = { ok: false, reason: "unreadable" } as const;
  const metadata = await file.slice(0, MAX_IMAGE_METADATA_BYTES).arrayBuffer();
  const view = new DataView(metadata);
  const meta = findHeicMetadataBox(view, 0, view.byteLength, 0x6d657461);
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return unreadable;
  const properties = findHeicMetadataBox(view, meta.payloadOffset + 4, meta.endOffset, 0x69707270);
  if (!properties) return unreadable;
  const containers = findHeicMetadataBox(
    view,
    properties.payloadOffset,
    properties.endOffset,
    0x6970636f,
  );
  if (!containers) return unreadable;

  let offset = containers.payloadOffset;
  let foundImageDimensions = false;
  while (offset < containers.endOffset) {
    const image = findHeicMetadataBox(view, offset, containers.endOffset, 0x69737065);
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return unreadable;
    const width = view.getUint32(image.payloadOffset + 4);
    const height = view.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return unreadable;
    if (width > MAX_HEIC_DECODE_PIXELS / height) return { ok: false, reason: "too-large" };
    foundImageDimensions = true;
    offset = image.endOffset;
  }
  if (!foundImageDimensions) return unreadable;

  let displayP3 = false;
  offset = containers.payloadOffset;
  while (!displayP3 && offset < containers.endOffset) {
    const color = findHeicMetadataBox(view, offset, containers.endOffset, 0x636f6c72);
    if (!color) break;
    displayP3 = heicColorIsDisplayP3(view, color);
    offset = color.endOffset;
  }
  return { ok: true, displayP3 };
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error(m(msg("Could not read image data."))));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error(m(msg("Failed to read image."))));
    });
    reader.readAsDataURL(file);
  });
}

function dataUrlLength(blob: Blob): number {
  return (
    `data:${blob.type || "application/octet-stream"};base64,`.length + 4 * Math.ceil(blob.size / 3)
  );
}

export function dataUrlToFile(dataUrl: string, name: string, mimeType: string): File {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType });
}

function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === "image/webp" ? ".webp" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${base}${extension}`;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

let imageWorker: Worker | null = null;
let imageWorkerUnavailable = false;
let nextImageWorkerId = 0;
const pendingImageWorkerTasks = new Map<number, (response: ImageWorkerResponse | null) => void>();

function settleImageWorkerTask(id: number, response: ImageWorkerResponse | null) {
  pendingImageWorkerTasks.get(id)?.(response);
  pendingImageWorkerTasks.delete(id);
}

function startImageWorker(): Worker | null {
  if (imageWorker || imageWorkerUnavailable || typeof Worker !== "function") return imageWorker;
  try {
    imageWorker = new Worker(new URL("./imageCompression.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    imageWorkerUnavailable = true;
    return null;
  }
  imageWorker.addEventListener("message", (event: MessageEvent<ImageWorkerResponse>) =>
    settleImageWorkerTask(event.data.id, event.data),
  );
  imageWorker.addEventListener("error", () => {
    imageWorkerUnavailable = true;
    imageWorker?.terminate();
    imageWorker = null;
    for (const id of pendingImageWorkerTasks.keys()) settleImageWorkerTask(id, null);
  });
  return imageWorker;
}

/**
 * Chromium runs main-thread canvas encodes as idle tasks (~1 s each on a page with no idle time),
 * and main-thread Blob reads wait behind every busy frame. A worker does neither.
 * `null` means the caller should do the work on the main thread.
 */
async function runInImageWorker<Task extends ImageWorkerTask>(
  task: Task,
  transfer: Transferable[] = [],
): Promise<{ value: ImageWorkerResults[Task["kind"]] } | null> {
  const worker = startImageWorker();
  if (!worker) return null;
  const id = nextImageWorkerId++;
  const response = await new Promise<ImageWorkerResponse | null>((resolve) => {
    pendingImageWorkerTasks.set(id, resolve);
    worker.postMessage({ id, task }, transfer);
  });
  return response && "value" in response
    ? { value: response.value as ImageWorkerResults[Task["kind"]] }
    : null;
}

export const encodeCanvas: EncodeCanvas = async (canvas, colorSpace, quality, mimeType) => {
  if (
    typeof OffscreenCanvas === "function" &&
    canvas instanceof OffscreenCanvas &&
    startImageWorker()
  ) {
    const bitmap = await createImageBitmap(canvas);
    // The worker may have failed during the snapshot; then this falls back below.
    const encoded = await runInImageWorker(
      { kind: "encode", bitmap, colorSpace, mimeType, quality },
      [bitmap],
    );
    if (encoded) return encoded.value;
    bitmap.close();
  }
  return encodeCanvasOnThisThread(canvas, colorSpace, quality, mimeType);
};

const composerThumbnails = new WeakMap<File, Promise<string | null>>();
const settledComposerThumbnails = new WeakMap<File, string | null>();

function cacheComposerImageThumbnail(
  file: File,
  thumbnail: Promise<string | null>,
): Promise<string | null> {
  composerThumbnails.set(file, thumbnail);
  void thumbnail.then((src) => settledComposerThumbnails.set(file, src));
  return thumbnail;
}

/** `undefined` until the thumbnail settles, so a tile can paint a known thumbnail immediately. */
export function readComposerImageThumbnail(file: File): string | null | undefined {
  return settledComposerThumbnails.get(file);
}

export function createComposerImageThumbnail(file: File): Promise<string | null> {
  return (
    composerThumbnails.get(file) ??
    cacheComposerImageThumbnail(file, renderComposerImageThumbnail(file))
  );
}

/**
 * Pasted images are re-encoded after their placeholder already shows the source's thumbnail.
 * Reusing it keeps the tile from flashing back to its fallback while the new file is decoded.
 * Resolves once the target's thumbnail is readable, so a tile swapped to it paints at once even
 * when compression finished before the source's thumbnail did.
 */
export async function inheritComposerImageThumbnail(source: File, target: File): Promise<void> {
  const sourceThumbnail = composerThumbnails.get(source);
  if (source === target || !sourceThumbnail || composerThumbnails.has(target)) return;
  cacheComposerImageThumbnail(
    target,
    sourceThumbnail.then((src) => src ?? renderComposerImageThumbnail(target)),
  );
  const src = await sourceThumbnail;
  if (src) settledComposerThumbnails.set(target, src);
}

async function renderComposerImageThumbnail(file: File): Promise<string | null> {
  if (isHeicImageFile(file)) return prepareHeicImage(file).thumbnail;
  // Placeholders thumbnail the uncompressed source, which can be big enough to OOM the decode.
  if (!canRecompress() || file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return null;
  try {
    const inWorker = await runInImageWorker({ kind: "thumbnail", file });
    if (inWorker) return inWorker.value;
    const blob = await renderThumbnail(file, encodeCanvas);
    return blob ? await readFileAsDataUrl(blob) : null;
  } catch {
    return null;
  }
}

async function renderComposerImageThumbnailFromBitmap(
  bitmap: ImageBitmap,
  colorSpace: PredefinedColorSpace,
): Promise<string | null> {
  try {
    const blob = await renderThumbnailFromBitmap(bitmap, colorSpace, encodeCanvas);
    return blob ? await readFileAsDataUrl(blob) : null;
  } catch {
    return null;
  }
}

async function encodeWithinBudget(
  bitmap: ImageBitmap,
  colorSpace: PredefinedColorSpace,
  maxDimension: number,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<{ blob: Blob; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height, colorSpace);
  if (!target) return null;

  // Probe the codec before drawing; JPEG needs a white matte because it has no alpha.
  const mimeType =
    preferredMimeType ??
    ((await encodeCanvas(target.canvas, colorSpace, QUALITY_STEPS[0], "image/webp"))
      ? "image/webp"
      : "image/jpeg");

  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(target.canvas, colorSpace, quality, mimeType);
    if (!encoded) break;
    if (dataUrlLength(encoded) <= budgetChars) {
      return { blob: encoded, mimeType, imageSize: { width, height } };
    }
  }
  return null;
}

type ReencodeResult =
  | { ok: true; blob: Blob; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

async function reencodeWithinBudget(
  file: File,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<ReencodeResult> {
  if (!canRecompress()) {
    return { ok: false, reason: "too-large" };
  }

  let bitmap: ImageBitmap;
  let colorSpace: PredefinedColorSpace;
  try {
    colorSpace = await readImageColorSpace(file);
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    // Shrink the previous target; using MAX_DIMENSION leaves smaller images unchanged.
    const baseDimension = Math.min(MAX_DIMENSION, Math.max(bitmap.width, bitmap.height));
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
      try {
        encoded = await encodeWithinBudget(
          bitmap,
          colorSpace,
          targetDimension,
          budgetChars,
          preferredMimeType,
        );
      } catch {
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded) {
        return {
          ok: true,
          blob: encoded.blob,
          mimeType: encoded.mimeType,
          imageSize: encoded.imageSize,
        };
      }
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

export async function compressImageForStash(
  file: File,
  budgetChars: number = MAX_STASH_IMAGE_DATA_URL_CHARS,
): Promise<CompressStashImageResult> {
  try {
    if (dataUrlLength(file) <= budgetChars) {
      return {
        ok: true,
        image: {
          dataUrl: await readFileAsDataUrl(file),
          mimeType: file.type,
          sizeBytes: file.size,
          recompressed: false,
        },
      };
    }
    const reencoded = await reencodeWithinBudget(file, budgetChars);
    if (!reencoded.ok) {
      return reencoded;
    }
    return {
      ok: true,
      image: {
        dataUrl: await readFileAsDataUrl(reencoded.blob),
        mimeType: reencoded.mimeType,
        sizeBytes: reencoded.blob.size,
        recompressed: true,
        imageSize: reencoded.imageSize,
      },
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

async function fitImageFileToMaxEdge(
  file: File,
): Promise<{ file: File; imageSize: ImageSize } | null> {
  const mimeType = downscalableImageMimeType(file.type);
  if (!mimeType || !canRecompress() || file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return null;
  try {
    const fitted =
      (await runInImageWorker({ kind: "fit", file, mimeType, quality: QUALITY_STEPS[0] })) ??
      ({ value: await fitImageToMaxEdge(file, mimeType, QUALITY_STEPS[0], encodeCanvas) } as const);
    if (!fitted.value) return null;
    return {
      file: new File([fitted.value.blob], file.name, {
        type: mimeType,
        lastModified: file.lastModified,
      }),
      imageSize: fitted.value.imageSize,
    };
  } catch {
    return null;
  }
}

export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: "image/jpeg"; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  const fitted = await fitImageFileToMaxEdge(file);
  if (fitted && fitted.file.size <= maxBytes) {
    return { ok: true, file: fitted.file, recompressed: true, imageSize: fitted.imageSize };
  }
  if (!fitted && file.size <= maxBytes) {
    return { ok: true, file, recompressed: false };
  }
  if ((options?.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const budgetChars = Math.floor(maxBytes / 3) * 4;
  const reencoded = await reencodeWithinBudget(
    fitted?.file ?? file,
    budgetChars,
    options?.preferredMimeType,
  );
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: new File(
      [reencoded.blob],
      fileNameForMimeType(file.name || "image", reencoded.mimeType),
      { type: reencoded.mimeType },
    ),
    recompressed: true,
    imageSize: reencoded.imageSize,
  };
}

const heicPreparations = new WeakMap<
  File,
  { image: Promise<CompressImageFileResult>; thumbnail: Promise<string | null> }
>();
// Preparing tiles share full-size decodes, so keep only one HEIC bitmap alive at a time.
let heicPreparationQueue = Promise.resolve();

function prepareHeicImage(file: File) {
  const cached = heicPreparations.get(file);
  if (cached) return cached;
  let resolveThumbnail!: (src: string | null) => void;
  const thumbnail = new Promise<string | null>((resolve) => {
    resolveThumbnail = resolve;
  });
  const image = heicPreparationQueue
    .then(() => convertHeicImage(file, resolveThumbnail))
    .finally(() => resolveThumbnail(null));
  heicPreparationQueue = image.then(
    () => undefined,
    () => undefined,
  );
  const preparation = { image, thumbnail };
  heicPreparations.set(file, preparation);
  return preparation;
}

async function readPixelsAsDisplayP3(
  bitmap: ImageBitmap,
  { width, height }: ImageSize,
): Promise<ImageBitmap | undefined> {
  const raw = createCanvas(width, height, "srgb");
  if (!raw) return undefined;
  raw.context.drawImage(bitmap, 0, 0, width, height);
  const pixels = raw.context.getImageData(0, 0, width, height);
  return createImageBitmap(new ImageData(pixels.data, width, height, { colorSpace: "display-p3" }));
}

async function convertHeicImage(
  file: File,
  onThumbnail: (src: string | null) => void,
): Promise<CompressImageFileResult> {
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let bitmap: ImageBitmap | undefined;
  try {
    const metadata = await readHeicMetadata(file);
    if (!metadata.ok) return metadata;
    bitmap =
      typeof createImageBitmap === "function"
        ? await createImageBitmap(file).catch(() => undefined)
        : undefined;
    const decodedNatively = bitmap !== undefined;
    if (!bitmap) {
      const { heicTo } = await loadHeicDecoder();
      bitmap = await heicTo({ blob: file, type: "bitmap" });
    }
    const imageSize = fitImageAttachmentSize(bitmap) ?? {
      width: bitmap.width,
      height: bitmap.height,
    };
    // heic-to ignores the color profile and hands back the raw Display P3 values as sRGB.
    if (!decodedNatively && metadata.displayP3) {
      const source = bitmap;
      bitmap = await readPixelsAsDisplayP3(source, imageSize);
      source.close();
      if (!bitmap) return { ok: false, reason: "unreadable" };
    }
    const colorSpace = metadata.displayP3 ? "display-p3" : "srgb";
    const surface = createCanvas(imageSize.width, imageSize.height, colorSpace);
    if (!surface) return { ok: false, reason: "unreadable" };
    surface.context.drawImage(bitmap, 0, 0, imageSize.width, imageSize.height);
    const [converted] = await Promise.all([
      encodeCanvas(surface.canvas, colorSpace, QUALITY_STEPS[0], "image/jpeg"),
      renderComposerImageThumbnailFromBitmap(bitmap, colorSpace).then(onThumbnail),
    ]);
    if (!converted) return { ok: false, reason: "unreadable" };
    return {
      ok: true,
      file: new File([converted], fileNameForMimeType(file.name || "image", "image/jpeg"), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      }),
      recompressed: true,
      imageSize,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    bitmap?.close();
  }
}

export async function prepareImageForAttachment(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) return compressImageToByteLimit(file, maxBytes);
  const prepared = await prepareHeicImage(file).image;
  if (!prepared.ok || prepared.file.size <= maxBytes) return prepared;
  const result = await compressImageToByteLimit(prepared.file, maxBytes, {
    preferredMimeType: "image/jpeg",
    sourceSizeBytes: file.size,
  });

  return result.ok ? { ...result, recompressed: true } : result;
}

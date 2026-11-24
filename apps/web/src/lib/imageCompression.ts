import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
  IMAGE_ATTACHMENT_MAX_EDGE,
} from "@t3tools/client-runtime/image-attachment-size";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import {
  type BitmapEncodeOptions,
  type ImageCompressionFailureReason,
  type ImageSize,
  QUALITY_STEPS,
  type ReencodeBitmapOptions,
  type ReencodeResult,
  createCanvas,
  dataUrlLength,
  encodeBitmapOnCanvas,
  reencodeBitmapWithinBudgetOnCanvas,
  thumbnailEncodeOptions,
} from "./imageCompressionCodec";
import type {
  ImageCompressionWorkerRequest,
  ImageCompressionWorkerResponse,
} from "./imageCompression.worker";

const MAX_DIMENSION = IMAGE_ATTACHMENT_MAX_EDGE;
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000;
/** Bound source decoding: enormous ImageBitmaps can OOM the tab before resizing. */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;

export type { ImageCompressionFailureReason };

export interface CompressedStashImage {
  imageSize?: ImageSize;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  recompressed: boolean;
}

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

// D50-adapted Display P3 primaries, as an ICC profile's rXYZ, gXYZ and bXYZ tags carry them.
const DISPLAY_P3_ICC_PRIMARIES = [
  [0x7258595a, 0.5151, 0.2412, -0.0011],
  [0x6758595a, 0.292, 0.6922, 0.0419],
  [0x6258595a, 0.1571, 0.0666, 0.7841],
] as const;

function iccProfileIsDisplayP3(view: DataView, start: number, end: number): boolean {
  if (start + 132 > end) return false;
  const tagCount = Math.min(view.getUint32(start + 128), Math.floor((end - start - 132) / 12));
  let matched = 0;
  for (let index = 0; index < tagCount; index += 1) {
    const entry = start + 132 + index * 12;
    const primary = DISPLAY_P3_ICC_PRIMARIES.find(
      ([signature]) => signature === view.getUint32(entry),
    );
    if (!primary) continue;
    const tag = start + view.getUint32(entry + 4);
    if (tag < start || tag + 20 > end || view.getUint32(tag) !== 0x58595a20) return false;
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(view.getInt32(tag + 8 + axis * 4) / 65536 - primary[axis + 1]!) > 0.005) {
        return false;
      }
    }
    matched += 1;
  }
  return matched === DISPLAY_P3_ICC_PRIMARIES.length;
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
  const metadata = await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer();
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

async function inflateIccProfile(deflated: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  const reader = new Blob([deflated])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      // A real profile is a few KiB; refuse to inflate a compression bomb.
      if (length > MAX_HEIC_METADATA_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const profile = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    profile.set(chunk, offset);
    offset += chunk.length;
  }
  return profile;
}

function iccProfileBytesAreDisplayP3(profile: Uint8Array): boolean {
  return iccProfileIsDisplayP3(
    new DataView(profile.buffer, profile.byteOffset, profile.byteLength),
    0,
    profile.byteLength,
  );
}

async function pngIsDisplayP3(bytes: Uint8Array<ArrayBuffer>, view: DataView): Promise<boolean> {
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const data = offset + 8;
    if (type === 0x49444154 || data + length > bytes.length) return false;
    if (type === 0x63494350) return length >= 1 && bytes[data] === 12;
    if (type === 0x69434350) {
      const nameEnd = bytes.subarray(data, data + Math.min(length, 80)).indexOf(0);
      if (nameEnd < 0) return false;
      const profile = await inflateIccProfile(bytes.slice(data + nameEnd + 2, data + length));
      return profile !== null && iccProfileBytesAreDisplayP3(profile);
    }
    offset = data + length + 4;
  }
  return false;
}

const JPEG_ICC_SIGNATURE = "ICC_PROFILE\0";

function jpegIsDisplayP3(bytes: Uint8Array, view: DataView): boolean {
  const segments: Uint8Array[] = [];
  for (let offset = 2; offset + 4 <= bytes.length && bytes[offset] === 0xff;) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) break;
    const signature = String.fromCharCode(...bytes.subarray(offset + 4, offset + 16));
    if (marker === 0xe2 && signature === JPEG_ICC_SIGNATURE) {
      segments.push(bytes.subarray(offset + 18, end));
    }
    offset = end;
  }
  if (segments.length === 0) return false;
  const profile = new Uint8Array(segments.reduce((total, segment) => total + segment.length, 0));
  let offset = 0;
  for (const segment of segments) {
    profile.set(segment, offset);
    offset += segment.length;
  }
  return iccProfileBytesAreDisplayP3(profile);
}

function webpIsDisplayP3(bytes: Uint8Array, view: DataView): boolean {
  if (view.getUint32(8) !== 0x57454250) return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = view.getUint32(offset);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + length > bytes.length) return false;
    if (type === 0x49434350) return iccProfileIsDisplayP3(view, data, data + length);
    offset = data + length + (length % 2);
  }
  return false;
}

/** Re-encode on a canvas in the source's own color space, so it keeps its gamut and profile. */
async function readImageColorSpace(file: Blob): Promise<PredefinedColorSpace> {
  const bytes = new Uint8Array(await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer());
  if (bytes.length < 16) return "srgb";
  const view = new DataView(bytes.buffer);
  const signature = view.getUint32(0);
  let displayP3 = false;
  if (signature === 0x89504e47) displayP3 = await pngIsDisplayP3(bytes, view);
  else if (signature >>> 16 === 0xffd8) displayP3 = jpegIsDisplayP3(bytes, view);
  else if (signature === 0x52494646) displayP3 = webpIsDisplayP3(bytes, view);
  return displayP3 ? "display-p3" : "srgb";
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

type PendingWorkerRequest =
  | {
      kind: "encode";
      resolve: (blob: Blob | null) => void;
      reject: (error: Error) => void;
      onThumbnail?: (blob: Blob | null) => void;
    }
  | {
      kind: "reencode";
      resolve: (result: ReencodeResult) => void;
      reject: (error: Error) => void;
    };

interface ActiveCompressionWorker {
  worker: Worker;
  nextId: number;
  pending: Map<number, PendingWorkerRequest>;
}

let activeCompressionWorker: ActiveCompressionWorker | null = null;

function canUseImageCompressionWorker(bitmap: ImageBitmap): boolean {
  return (
    typeof Worker === "function" &&
    typeof OffscreenCanvas === "function" &&
    typeof ImageBitmap === "function" &&
    bitmap instanceof ImageBitmap
  );
}

function releaseCompressionWorker(session: ActiveCompressionWorker) {
  if (session.pending.size > 0) return;
  session.worker.terminate();
  if (activeCompressionWorker === session) activeCompressionWorker = null;
}

function failCompressionWorker(session: ActiveCompressionWorker, error: Error) {
  if (activeCompressionWorker === session) activeCompressionWorker = null;
  session.worker.terminate();
  const entries = [...session.pending.values()];
  session.pending.clear();
  for (const entry of entries) entry.reject(error);
}

/**
 * Main-thread `OffscreenCanvas.convertToBlob` runs on Chromium's idle task queue and can stall
 * for seconds on high-refresh displays while the UI animates. Dedicated workers encode directly.
 */
function acquireCompressionWorker(): ActiveCompressionWorker | null {
  if (activeCompressionWorker) return activeCompressionWorker;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./imageCompression.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return null;
  }
  const session: ActiveCompressionWorker = {
    worker,
    nextId: 0,
    pending: new Map(),
  };
  worker.addEventListener("message", (event: MessageEvent<ImageCompressionWorkerResponse>) => {
    const entry = session.pending.get(event.data.id);
    if (!entry) return;
    if (event.data.kind === "thumbnail") {
      if (entry.kind === "encode") entry.onThumbnail?.(event.data.blob);
      return;
    }
    session.pending.delete(event.data.id);
    releaseCompressionWorker(session);
    if (event.data.kind === "encode-result" && entry.kind === "encode") {
      entry.resolve(event.data.blob);
    } else if (event.data.kind === "reencode-result" && entry.kind === "reencode") {
      entry.resolve(event.data.result);
    } else {
      entry.reject(new Error("Image compression worker failed."));
    }
  });
  worker.addEventListener("error", () =>
    failCompressionWorker(session, new Error("Image compression worker failed.")),
  );
  worker.addEventListener("messageerror", () =>
    failCompressionWorker(session, new Error("Image compression worker message failed.")),
  );
  activeCompressionWorker = session;
  return session;
}

async function encodeBitmap(
  bitmap: ImageBitmap,
  options: BitmapEncodeOptions,
  extra?: {
    thumbnailOptions?: BitmapEncodeOptions | null;
    onThumbnail?: (blob: Blob | null) => void;
  },
): Promise<Blob | null> {
  if (canUseImageCompressionWorker(bitmap)) {
    const session = acquireCompressionWorker();
    if (session) {
      return new Promise<Blob | null>((resolve, reject) => {
        const id = ++session.nextId;
        session.pending.set(id, {
          kind: "encode",
          resolve,
          reject,
          ...(extra?.onThumbnail ? { onThumbnail: extra.onThumbnail } : {}),
        });
        const request: ImageCompressionWorkerRequest = {
          id,
          kind: "encode",
          bitmap,
          options,
          ...(extra?.thumbnailOptions !== undefined
            ? { thumbnailOptions: extra.thumbnailOptions }
            : {}),
        };
        try {
          session.worker.postMessage(request, [bitmap]);
        } catch (error) {
          session.pending.delete(id);
          releaseCompressionWorker(session);
          reject(error instanceof Error ? error : new Error("Failed to dispatch image encode."));
        }
      });
    }
  }
  const mainEncode = encodeBitmapOnCanvas(bitmap, options);
  const thumbnailEncode = extra?.thumbnailOptions
    ? encodeBitmapOnCanvas(bitmap, extra.thumbnailOptions)
        .catch(() => null)
        .then((blob) => {
          extra.onThumbnail?.(blob);
        })
    : Promise.resolve();
  const [blob] = await Promise.all([mainEncode, thumbnailEncode]);
  return blob;
}

async function reencodeBitmapWithinBudget(
  bitmap: ImageBitmap,
  options: ReencodeBitmapOptions,
): Promise<ReencodeResult> {
  if (canUseImageCompressionWorker(bitmap)) {
    const session = acquireCompressionWorker();
    if (session) {
      return new Promise<ReencodeResult>((resolve, reject) => {
        const id = ++session.nextId;
        session.pending.set(id, { kind: "reencode", resolve, reject });
        const request: ImageCompressionWorkerRequest = {
          id,
          kind: "reencode",
          bitmap,
          options,
        };
        try {
          session.worker.postMessage(request, [bitmap]);
        } catch (error) {
          session.pending.delete(id);
          releaseCompressionWorker(session);
          reject(error instanceof Error ? error : new Error("Failed to dispatch image reencode."));
        }
      });
    }
  }
  return reencodeBitmapWithinBudgetOnCanvas(bitmap, options);
}

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
  let bitmap: ImageBitmap | undefined;
  try {
    const colorSpace = await readImageColorSpace(file);
    bitmap = await createImageBitmap(file);
    const options = thumbnailEncodeOptions(bitmap, colorSpace);
    if (!options) return null;
    const blob = await encodeBitmap(bitmap, options);
    return blob ? await readFileAsDataUrl(blob) : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

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
    return await reencodeBitmapWithinBudget(bitmap, {
      colorSpace,
      maxDimension: MAX_DIMENSION,
      budgetChars,
      ...(preferredMimeType ? { preferredMimeType } : {}),
    });
  } catch {
    return { ok: false, reason: "unreadable" };
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

async function fitImageToMaxEdge(file: File): Promise<{ file: File; imageSize: ImageSize } | null> {
  const mimeType = downscalableImageMimeType(file.type);
  if (!mimeType || !canRecompress() || file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return null;
  let bitmap: ImageBitmap | undefined;
  try {
    const header = readImageDimensions(
      new Uint8Array(await file.slice(0, IMAGE_DIMENSIONS_HEADER_BYTES).arrayBuffer()),
    );
    if (!header || !fitImageAttachmentSize(header)) return null;
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const imageSize = fitImageAttachmentSize(bitmap);
    if (!imageSize) return null;
    const blob = await encodeBitmap(bitmap, {
      width: imageSize.width,
      height: imageSize.height,
      colorSpace: await readImageColorSpace(file),
      mimeType,
      quality: QUALITY_STEPS[0],
      imageSmoothingQuality: "high",
    });
    if (!blob) return null;
    return {
      file: new File([blob], file.name, { type: mimeType, lastModified: file.lastModified }),
      imageSize,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: "image/jpeg"; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  const fitted = await fitImageToMaxEdge(file);
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
      const { heicTo } = await import("heic-to/csp");
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
    let thumbnailPromise: Promise<void> | undefined;
    const converted = await encodeBitmap(
      bitmap,
      {
        width: imageSize.width,
        height: imageSize.height,
        colorSpace,
        mimeType: "image/jpeg",
        quality: QUALITY_STEPS[0],
      },
      {
        thumbnailOptions: thumbnailEncodeOptions(bitmap, colorSpace),
        onThumbnail: (blob) => {
          thumbnailPromise = (
            blob ? readFileAsDataUrl(blob).catch(() => null) : Promise.resolve(null)
          ).then(onThumbnail);
        },
      },
    );
    await thumbnailPromise;
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

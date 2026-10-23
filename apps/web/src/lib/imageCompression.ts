import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
  IMAGE_ATTACHMENT_MAX_EDGE,
} from "@t3tools/client-runtime/image-attachment-size";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

const MAX_DIMENSION = IMAGE_ATTACHMENT_MAX_EDGE;
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000;
/**
 * Ceiling on the *source* file handed to the re-encoder. File size is a
 * proxy for pixel count, and decoding hundreds of megapixels into an
 * ImageBitmap can OOM the tab — beyond this we refuse rather than risk it.
 */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;

type ImageSize = { width: number; height: number };

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

async function validateHeicImageDimensions(
  file: File,
): Promise<ImageCompressionFailureReason | null> {
  const metadata = await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer();
  const view = new DataView(metadata);
  const meta = findHeicMetadataBox(view, 0, view.byteLength, 0x6d657461);
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return "unreadable";
  const properties = findHeicMetadataBox(view, meta.payloadOffset + 4, meta.endOffset, 0x69707270);
  if (!properties) return "unreadable";
  const containers = findHeicMetadataBox(
    view,
    properties.payloadOffset,
    properties.endOffset,
    0x6970636f,
  );
  if (!containers) return "unreadable";

  let offset = containers.payloadOffset;
  let foundImageDimensions = false;
  while (offset < containers.endOffset) {
    const image = findHeicMetadataBox(view, offset, containers.endOffset, 0x69737065);
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return "unreadable";
    const width = view.getUint32(image.payloadOffset + 4);
    const height = view.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return "unreadable";
    if (width > MAX_HEIC_DECODE_PIXELS / height) return "too-large";
    foundImageDimensions = true;
    offset = image.endOffset;
  }
  return foundImageDimensions ? null : "unreadable";
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
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

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  return { canvas, context };
}

async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<Blob | null> {
  let blob: Blob | null;
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  }
  return blob?.type === mimeType ? blob : null;
}

const composerThumbnails = new WeakMap<File, Promise<string | null>>();

export function createComposerImageThumbnail(file: File): Promise<string | null> {
  const cached = composerThumbnails.get(file);
  if (cached) return cached;
  const thumbnail = (async () => {
    if (!canRecompress()) return null;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      if (side <= 0) return null;
      const dimension = Math.min(256, side);
      const surface = createCanvas(dimension, dimension);
      if (!surface) return null;
      surface.context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        dimension,
        dimension,
      );
      const blob = await encodeCanvas(surface.canvas, 1, "image/png");
      return blob ? await readFileAsDataUrl(blob) : null;
    } catch {
      return null;
    } finally {
      bitmap?.close();
    }
  })();
  composerThumbnails.set(file, thumbnail);
  return thumbnail;
}

async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<{ blob: Blob; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;

  // Probe WebP once; JPEG (no alpha) needs a white matte, so the fill has to
  // happen before drawing and depends on which codec we end up using.
  const mimeType =
    preferredMimeType ??
    ((await encodeCanvas(target.canvas, QUALITY_STEPS[0], "image/webp"))
      ? "image/webp"
      : "image/jpeg");

  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(target.canvas, quality, mimeType);
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
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    // Each pass shrinks relative to the *previous target*, capped by
    // MAX_DIMENSION. Scaling a fixed ceiling instead would be a no-op for
    // images already smaller than that ceiling — the fallback passes would
    // all resolve to the source size and never actually reduce resolution.
    const baseDimension = Math.min(MAX_DIMENSION, Math.max(bitmap.width, bitmap.height));
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
      try {
        encoded = await encodeWithinBudget(bitmap, targetDimension, budgetChars, preferredMimeType);
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
    const target = createCanvas(imageSize.width, imageSize.height);
    if (!target) return null;
    target.context.imageSmoothingQuality = "high";
    target.context.drawImage(bitmap, 0, 0, imageSize.width, imageSize.height);
    const blob = await encodeCanvas(target.canvas, QUALITY_STEPS[0], mimeType);
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

export async function prepareImageForAttachment(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) {
    return compressImageToByteLimit(file, maxBytes);
  }

  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let converted: Blob;
  try {
    const dimensionError = await validateHeicImageDimensions(file);
    if (dimensionError) {
      return { ok: false, reason: dimensionError };
    }
    const { heicTo } = await import("heic-to/csp");
    converted = await heicTo({ blob: file, type: "image/jpeg", quality: QUALITY_STEPS[0] });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const jpeg = new File([converted], fileNameForMimeType(file.name || "image", "image/jpeg"), {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
  const result = await compressImageToByteLimit(jpeg, maxBytes, {
    preferredMimeType: "image/jpeg",
    sourceSizeBytes: file.size,
  });

  return result.ok ? { ...result, recompressed: true } : result;
}

/**
 * Downscale + re-encode for image attachments that are too big for where
 * they're headed. Two consumers share the same pipeline:
 *
 * - The prompt stash persists images as base64 in localStorage (~5MB origin
 *   quota), so `compressImageForStash` targets a per-image character budget.
 * - The composer accepts pasted/dropped images larger than the provider's
 *   `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` wire cap and shrinks them to fit
 *   via `compressImageToByteLimit` instead of rejecting the paste.
 *
 * Images already within budget pass through untouched.
 */

/**
 * Longest edge kept when an image has to be re-encoded. Sized so a typical
 * retina screenshot (3024px wide) stays legible rather than being halved.
 */
const MAX_DIMENSION = 2048;
/** Base64 budget for a single stashed image (~975KB of binary). */
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000;
/**
 * Ceiling on the *source* file handed to the re-encoder. File size is a
 * proxy for pixel count, and decoding hundreds of megapixels into an
 * ImageBitmap can OOM the tab — beyond this we refuse rather than risk it.
 */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
/**
 * Quality ladder tried in order until the encoded image fits the budget.
 * The floor stays high enough to avoid visible blocking on UI screenshots;
 * if even that overflows we drop resolution instead of quality.
 */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
/** Extra downscale passes applied when even the lowest quality overflows. */
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;

export interface CompressedStashImage {
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  /** True when the payload was re-encoded rather than stored verbatim. */
  recompressed: boolean;
}

/**
 * Why an image could not be compressed. Callers report these differently:
 * "too large" is a budget outcome, "unreadable" is a decode failure.
 */
export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type CompressStashImageResult =
  | { ok: true; image: CompressedStashImage }
  | { ok: false; reason: ImageCompressionFailureReason };

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean }
  | { ok: false; reason: ImageCompressionFailureReason };

/** Chunked so a large image can't blow the argument limit of `fromCharCode`. */
const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Blob → base64 data URL. Uses `arrayBuffer()` rather than `FileReader` so
 * the module works anywhere `Blob` does (including non-DOM test runners).
 */
async function blobToDataUrl(blob: File | Blob, mimeTypeOverride?: string): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const mimeType = mimeTypeOverride || blob.type || "application/octet-stream";
  return `data:${mimeType};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

/** Approximate decoded byte count for a base64 data URL. */
function dataUrlByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  const payload = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Base64 payload of a data URL decoded back into a `File`. */
function dataUrlToFile(dataUrl: string, name: string, mimeType: string): File {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType });
}

/**
 * Re-encoding changes the container, so a name like `shot.png` would lie
 * about its contents. Swap the extension to match the encoded mime type.
 */
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

/**
 * WebP is preferred: at matched visual quality it lands roughly 25-35%
 * smaller than JPEG, so the same budget buys more resolution and detail —
 * and it keeps alpha, so screenshots with transparency survive intact.
 * Browsers that can't encode it silently fall back to JPEG.
 */
async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
  budgetChars: number,
): Promise<{ dataUrl: string | null; mimeType: string } | null> {
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    // toDataURL silently returns a PNG when the requested type is unsupported.
    if (!dataUrl.startsWith(`data:${mimeType}`)) return null;
    return { dataUrl: dataUrl.length <= budgetChars ? dataUrl : null, mimeType };
  }
  const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  if (blob.type && blob.type !== mimeType) return null;
  const dataUrlLength = `data:${mimeType};base64,`.length + 4 * Math.ceil(blob.size / 3);
  if (dataUrlLength > budgetChars) return { dataUrl: null, mimeType };
  return { dataUrl: await blobToDataUrl(blob, mimeType), mimeType };
}

/**
 * Draws `bitmap` scaled to fit `maxDimension` and encodes it, stepping
 * quality down until the data URL fits `budgetChars`.
 */
async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
): Promise<{ dataUrl: string; mimeType: string } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;

  // Probe WebP once; JPEG (no alpha) needs a white matte, so the fill has to
  // happen before drawing and depends on which codec we end up using.
  const probe = await encodeCanvas(target.canvas, QUALITY_STEPS[0], "image/webp", 0);
  const mimeType = probe ? "image/webp" : "image/jpeg";

  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(target.canvas, quality, mimeType, budgetChars);
    if (!encoded) break;
    if (encoded.dataUrl !== null) {
      return { dataUrl: encoded.dataUrl, mimeType: encoded.mimeType };
    }
  }
  return null;
}

type ReencodeResult =
  | { ok: true; dataUrl: string; mimeType: string }
  | { ok: false; reason: ImageCompressionFailureReason };

/**
 * Shared re-encode loop: decodes `file`, then walks the quality ladder and
 * fallback downscale passes until an encoding fits `budgetChars`.
 */
async function reencodeWithinBudget(file: File, budgetChars: number): Promise<ReencodeResult> {
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
    // Tracks whether the *last* attempt threw, so a run of encoder failures
    // is reported as unreadable while a run of merely-too-big results is
    // reported as too-large.
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: { dataUrl: string; mimeType: string } | null;
      try {
        encoded = await encodeWithinBudget(bitmap, targetDimension, budgetChars);
      } catch {
        // Canvas allocation, drawing, or the codec itself can throw — often
        // precisely *because* the target is too big (OOM on a large bitmap).
        // Keep trying the smaller fallback scales rather than giving up: a
        // reduced pass may well succeed. The exception must never escape,
        // though, since callers finalize state after this returns and a
        // throw would strand it (e.g. a stash entry stuck "still saving").
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded && encoded.dataUrl.length <= budgetChars) {
        return { ok: true, dataUrl: encoded.dataUrl, mimeType: encoded.mimeType };
      }
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

/**
 * Produces the payload to persist for a stashed image.
 *
 * Small images are stored verbatim (preserving PNG transparency and exact
 * pixels). Anything over budget is downscaled and re-encoded; if it still
 * doesn't fit after the fallback passes, reports a failure so the caller
 * can record it as dropped.
 */
export async function compressImageForStash(
  file: File,
  budgetChars: number = MAX_STASH_IMAGE_DATA_URL_CHARS,
): Promise<CompressStashImageResult> {
  let originalDataUrl: string;
  try {
    originalDataUrl = await blobToDataUrl(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (originalDataUrl.length <= budgetChars) {
    return {
      ok: true,
      image: {
        dataUrl: originalDataUrl,
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
      dataUrl: reencoded.dataUrl,
      mimeType: reencoded.mimeType,
      sizeBytes: dataUrlByteLength(reencoded.dataUrl),
      recompressed: true,
    },
  };
}

/**
 * Shrinks `file` until its binary size fits `maxBytes`, returning a new
 * `File` (WebP or JPEG). Files already within the limit pass through
 * untouched, preserving their exact bytes and format. Sources above
 * `MAX_COMPRESSIBLE_SOURCE_BYTES` are refused outright — decoding them is
 * the risk, so no amount of output budget makes them safe.
 */
export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  if (file.size <= maxBytes) {
    return { ok: true, file, recompressed: false };
  }
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  // The re-encode loop budgets in data-URL characters. Base64 turns 3 bytes
  // into 4 chars; flooring keeps the budget a hair conservative instead of
  // admitting an encoding right at the byte cap.
  const budgetChars = Math.floor(maxBytes / 3) * 4;
  const reencoded = await reencodeWithinBudget(file, budgetChars);
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: dataUrlToFile(
      reencoded.dataUrl,
      fileNameForMimeType(file.name || "image", reencoded.mimeType),
      reencoded.mimeType,
    ),
    recompressed: true,
  };
}

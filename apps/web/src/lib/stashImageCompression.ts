/**
 * Re-encoding for stashed image attachments.
 *
 * The composer accepts images up to `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`
 * (10MB), but the stash persists them as base64 in localStorage, where the
 * whole origin shares a ~5MB quota. Rather than refuse large screenshots,
 * downscale + re-encode them to JPEG so a stashed prompt keeps its images.
 *
 * Only the *stashed copy* is compressed; the live composer attachment is
 * untouched, so sending without stashing still uploads the original file.
 */

/**
 * Longest edge kept when an image has to be re-encoded. Sized so a typical
 * retina screenshot (3024px wide) stays legible rather than being halved.
 */
const MAX_DIMENSION = 2048;
/** Base64 budget for a single stashed image (~975KB of binary). */
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000;
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
 * Why an image could not be stashed. Callers report these differently:
 * "too large" is a budget outcome, "unreadable" is a decode failure.
 */
export type StashImageFailureReason = "too-large" | "unreadable";

export type CompressStashImageResult =
  | { ok: true; image: CompressedStashImage }
  | { ok: false; reason: StashImageFailureReason };

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
async function encodeToDataUrl(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<{ dataUrl: string; mimeType: string } | null> {
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    // toDataURL silently returns a PNG when the requested type is unsupported.
    if (!dataUrl.startsWith(`data:${mimeType}`)) return null;
    return { dataUrl, mimeType };
  }
  const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  if (blob.type && blob.type !== mimeType) return null;
  return { dataUrl: await blobToDataUrl(blob, mimeType), mimeType };
}

/**
 * Draws `bitmap` scaled to fit `maxDimension` and encodes it as JPEG,
 * stepping quality down until the data URL fits `budgetChars`. Returns the
 * smallest encoding produced, even if it still exceeds the budget, so the
 * caller can decide whether to keep or drop it.
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
  const probe = await encodeToDataUrl(target.canvas, QUALITY_STEPS[0], "image/webp");
  const mimeType = probe ? "image/webp" : "image/jpeg";

  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  let smallest: { dataUrl: string; mimeType: string } | null = null;
  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeToDataUrl(target.canvas, quality, mimeType);
    if (!encoded) break;
    if (smallest === null || encoded.dataUrl.length < smallest.dataUrl.length) {
      smallest = encoded;
    }
    if (encoded.dataUrl.length <= budgetChars) {
      return encoded;
    }
  }
  return smallest;
}

/**
 * Produces the payload to persist for a stashed image.
 *
 * Small images are stored verbatim (preserving PNG transparency and exact
 * pixels). Anything over budget is downscaled and JPEG-encoded; if it still
 * doesn't fit after the fallback passes, returns `null` so the caller can
 * record it as dropped.
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
        // though, since the caller finalizes the entry after this returns and
        // a throw would strand it as permanently "still saving".
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded && encoded.dataUrl.length <= budgetChars) {
        return {
          ok: true,
          image: {
            dataUrl: encoded.dataUrl,
            mimeType: encoded.mimeType,
            sizeBytes: dataUrlByteLength(encoded.dataUrl),
            recompressed: true,
          },
        };
      }
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

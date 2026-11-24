export const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;

export type ImageSize = { width: number; height: number };
export type ImageCompressionFailureReason = "too-large" | "unreadable";

export interface BitmapEncodeOptions {
  width: number;
  height: number;
  colorSpace: PredefinedColorSpace;
  mimeType: string;
  quality: number;
  crop?: { sx: number; sy: number; sw: number; sh: number };
  imageSmoothingQuality?: ImageSmoothingQuality;
}

export interface ReencodeBitmapOptions {
  colorSpace: PredefinedColorSpace;
  maxDimension: number;
  budgetChars: number;
  preferredMimeType?: "image/jpeg";
}

export type ReencodeResult =
  | { ok: true; blob: Blob; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

export function dataUrlLength(blob: Blob): number {
  return (
    `data:${blob.type || "application/octet-stream"};base64,`.length + 4 * Math.ceil(blob.size / 3)
  );
}

export function createCanvas(
  width: number,
  height: number,
  colorSpace: PredefinedColorSpace,
): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { colorSpace });
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { colorSpace });
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

export function thumbnailEncodeOptions(
  size: ImageSize,
  colorSpace: PredefinedColorSpace,
): BitmapEncodeOptions | null {
  const side = Math.min(size.width, size.height);
  if (side <= 0) return null;
  const dimension = Math.min(256, side);
  return {
    width: dimension,
    height: dimension,
    colorSpace,
    mimeType: "image/png",
    quality: 1,
    crop: {
      sx: (size.width - side) / 2,
      sy: (size.height - side) / 2,
      sw: side,
      sh: side,
    },
  };
}

export async function encodeBitmapOnCanvas(
  bitmap: ImageBitmap,
  options: BitmapEncodeOptions,
): Promise<Blob | null> {
  const surface = createCanvas(options.width, options.height, options.colorSpace);
  if (!surface) return null;
  if (options.imageSmoothingQuality) {
    surface.context.imageSmoothingQuality = options.imageSmoothingQuality;
  }
  if (options.crop) {
    surface.context.drawImage(
      bitmap,
      options.crop.sx,
      options.crop.sy,
      options.crop.sw,
      options.crop.sh,
      0,
      0,
      options.width,
      options.height,
    );
  } else {
    surface.context.drawImage(bitmap, 0, 0, options.width, options.height);
  }
  return encodeCanvas(surface.canvas, options.quality, options.mimeType);
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

export async function reencodeBitmapWithinBudgetOnCanvas(
  bitmap: ImageBitmap,
  options: ReencodeBitmapOptions,
): Promise<ReencodeResult> {
  // Shrink the previous target; using maxDimension leaves smaller images unchanged.
  const baseDimension = Math.min(options.maxDimension, Math.max(bitmap.width, bitmap.height));
  let encodeFailed = false;
  for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
    const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
    let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
    try {
      encoded = await encodeWithinBudget(
        bitmap,
        options.colorSpace,
        targetDimension,
        options.budgetChars,
        options.preferredMimeType,
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
}

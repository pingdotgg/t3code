import sharp from "sharp";

export interface RgbaImage {
  readonly data: Uint8Array;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

export interface DecodeImageOptions {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxInputPixels?: number;
}

const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;

export async function decodeImage(
  encoded: Uint8Array,
  options: DecodeImageOptions = {},
): Promise<RgbaImage> {
  const maxWidth = options.maxWidth;
  const maxHeight = options.maxHeight;
  assertOptionalDimension(maxWidth, "maxWidth");
  assertOptionalDimension(maxHeight, "maxHeight");
  const maxInputPixels = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;
  assertDimension(maxInputPixels, "maxInputPixels");

  let pipeline = sharp(encoded, {
    animated: false,
    failOn: "error",
    limitInputPixels: maxInputPixels,
    sequentialRead: true,
  }).rotate();
  if (maxWidth !== undefined || maxHeight !== undefined) {
    pipeline = pipeline.resize({
      ...(maxWidth !== undefined ? { width: maxWidth } : {}),
      ...(maxHeight !== undefined ? { height: maxHeight } : {}),
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const result = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    imageWidth: result.info.width,
    imageHeight: result.info.height,
  };
}

function assertDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertOptionalDimension(value: number | undefined, name: string): void {
  if (value !== undefined) assertDimension(value, name);
}

import { fitImageAttachmentSize } from "@t3tools/client-runtime/image-attachment-size";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

// Canvas work shared by the main thread and imageCompression.worker.ts, so it imports no UI code.

export const MAX_IMAGE_METADATA_BYTES = 1024 * 1024;

export type ImageSize = { width: number; height: number };

export type EncodeCanvas = (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  colorSpace: PredefinedColorSpace,
  quality: number,
  mimeType: string,
) => Promise<Blob | null>;

// D50-adapted Display P3 primaries, as an ICC profile's rXYZ, gXYZ and bXYZ tags carry them.
const DISPLAY_P3_ICC_PRIMARIES = [
  [0x7258595a, 0.5151, 0.2412, -0.0011],
  [0x6758595a, 0.292, 0.6922, 0.0419],
  [0x6258595a, 0.1571, 0.0666, 0.7841],
] as const;

export function iccProfileIsDisplayP3(view: DataView, start: number, end: number): boolean {
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
      if (length > MAX_IMAGE_METADATA_BYTES) return null;
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
export async function readImageColorSpace(file: Blob): Promise<PredefinedColorSpace> {
  const bytes = new Uint8Array(await file.slice(0, MAX_IMAGE_METADATA_BYTES).arrayBuffer());
  if (bytes.length < 16) return "srgb";
  const view = new DataView(bytes.buffer);
  const signature = view.getUint32(0);
  let displayP3 = false;
  if (signature === 0x89504e47) displayP3 = await pngIsDisplayP3(bytes, view);
  else if (signature >>> 16 === 0xffd8) displayP3 = jpegIsDisplayP3(bytes, view);
  else if (signature === 0x52494646) displayP3 = webpIsDisplayP3(bytes, view);
  return displayP3 ? "display-p3" : "srgb";
}

export interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
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

export const encodeCanvasOnThisThread: EncodeCanvas = async (
  canvas,
  _colorSpace,
  quality,
  mimeType,
) => {
  let blob: Blob | null;
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  }
  return blob?.type === mimeType ? blob : null;
};

/** macOS pastes a photo copied from an iPhone as a 16-bit PNG, several times its 8-bit size. */
function isSixteenBitPng(header: Uint8Array): boolean {
  return (
    header.length > 24 &&
    new DataView(header.buffer, header.byteOffset).getUint32(0) === 0x89504e47 &&
    header[24] === 16
  );
}

/**
 * Redraws an image over the max edge, or a 16-bit PNG at its own size. `null` when there's
 * nothing to gain, or the browser cannot draw or encode it.
 */
export async function fitImageForAttachment(
  file: Blob,
  mimeType: string,
  quality: number,
  encode: EncodeCanvas,
): Promise<{ blob: Blob; imageSize: ImageSize } | null> {
  const headerBytes = new Uint8Array(
    await file.slice(0, IMAGE_DIMENSIONS_HEADER_BYTES).arrayBuffer(),
  );
  const header = readImageDimensions(headerBytes);
  if (!header || (!fitImageAttachmentSize(header) && !isSixteenBitPng(headerBytes))) return null;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scaledSize = fitImageAttachmentSize(bitmap);
    const imageSize = scaledSize ?? { width: bitmap.width, height: bitmap.height };
    const colorSpace = await readImageColorSpace(file);
    const target = createCanvas(imageSize.width, imageSize.height, colorSpace);
    if (!target) return null;
    target.context.imageSmoothingQuality = "high";
    target.context.drawImage(bitmap, 0, 0, imageSize.width, imageSize.height);
    const blob = await encode(target.canvas, colorSpace, quality, mimeType);
    // The canvas writes RGBA, so a 16-bit grayscale PNG can come out larger at 8 bits.
    if (!blob || (!scaledSize && blob.size >= file.size)) return null;
    return { blob, imageSize };
  } finally {
    bitmap.close();
  }
}

export async function renderThumbnailFromBitmap(
  bitmap: ImageBitmap,
  colorSpace: PredefinedColorSpace,
  encode: EncodeCanvas,
): Promise<Blob | null> {
  const side = Math.min(bitmap.width, bitmap.height);
  if (side <= 0) return null;
  const dimension = Math.min(256, side);
  const surface = createCanvas(dimension, dimension, colorSpace);
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
  return encode(surface.canvas, colorSpace, 1, "image/png");
}

export async function renderThumbnail(file: Blob, encode: EncodeCanvas): Promise<Blob | null> {
  const colorSpace = await readImageColorSpace(file);
  const bitmap = await createImageBitmap(file);
  try {
    return await renderThumbnailFromBitmap(bitmap, colorSpace, encode);
  } finally {
    bitmap.close();
  }
}

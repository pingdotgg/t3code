/**
 * Intrinsic raster dimensions read straight out of a file's header.
 *
 * Decoding an image is what materializes width×height×4 bytes in the renderer,
 * so anything that has to *refuse* an enormous one has to know its size before
 * handing it to a decoder — by then the memory is already spent. Every format
 * here states its size within the first bytes of the file. Anything else reads
 * as null, leaving the caller to fall back on measuring after a decode.
 */

/** Enough of a file to reach the header of every format read here. */
export const IMAGE_HEADER_BYTES = 64 * 1024;

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;
const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const BMP_SIGNATURE = [0x42, 0x4d] as const;
const FTYP_TYPE = [0x66, 0x74, 0x79, 0x70] as const;
const AVIF_BRANDS = new Set(["avif", "avis"]);
const ISPE_TYPE = [0x69, 0x73, 0x70, 0x65] as const;
/** Type, version and flags, width, height — measured from the type. */
const ISPE_FIELD_BYTES = 16;

function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** IHDR is required to be the first chunk, and states the size big-endian. */
function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasSignature(bytes, PNG_SIGNATURE) || bytes.length < 24) return null;
  const view = viewOf(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The logical screen size follows the version stamp, little-endian. */
function readGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasSignature(bytes, GIF_SIGNATURE) || bytes.length < 10) return null;
  const view = viewOf(bytes);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/**
 * A RIFF container whose first chunk is one of three codecs, each of which
 * states the size its own way: extended files carry the canvas size minus one
 * as 24-bit fields, lossy files put 14-bit fields after the frame start code,
 * and lossless files pack both into one 32-bit word.
 */
function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasSignature(bytes, RIFF_SIGNATURE) || !hasSignature(bytes, WEBP_SIGNATURE, 8)) return null;
  if (bytes.length < 16) return null;
  const view = viewOf(bytes);
  const codec = String.fromCharCode(...bytes.subarray(12, 16));
  if (codec === "VP8X" && bytes.length >= 30) {
    return {
      width: (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1,
      height: (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1,
    };
  }
  if (codec === "VP8 " && bytes.length >= 30) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (codec === "VP8L" && bytes.length >= 25) {
    const packed = view.getUint32(21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Frame headers, the only segments that state the image size. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  // Huffman tables, arithmetic conditioning, and JPEG extensions share the range.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Walks the marker segments to the frame header. Metadata segments (EXIF, ICC,
 * comments) come first and can be large, which is what the header window is
 * sized for; a file whose frame header sits past it reads as unmeasurable
 * rather than wrong.
 */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasSignature(bytes, JPEG_SIGNATURE)) return null;
  const view = viewOf(bytes);
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    // Any number of 0xff bytes may pad the gap before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    // Entropy-coded scan data starts here and no frame header follows it.
    if (marker === 0xda) return null;
    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * The DIB header states the size, as 16-bit fields in the original flavor and
 * signed 32-bit ones in every flavor since. A negative height means the rows
 * are stored top-down; the magnitude is the same either way.
 */
function readBmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasSignature(bytes, BMP_SIGNATURE) || bytes.length < 26) return null;
  const view = viewOf(bytes);
  if (view.getUint32(14, true) === 12) {
    return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
  }
  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

/** The box at `offset` as `[type, end]`, or null if its header is cut off. */
function readBoxHeader(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
): { type: string; end: number } | null {
  if (offset + 8 > bytes.length) return null;
  const size = view.getUint32(offset);
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  // A size of 1 puts the real one in a 64-bit field after the type; 0 runs to EOF.
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    return { type, end: offset + Number(view.getBigUint64(offset + 8)) };
  }
  const end = size === 0 ? bytes.length : offset + size;
  return end > offset ? { type, end } : null;
}

/**
 * AVIF states its size in an `ispe` box nested inside `meta`. Rather than walk
 * the property tree down to it, this finds `meta` among the top-level boxes and
 * scans it for every `ispe`, taking the largest extent: a file can declare
 * several (thumbnails, alpha, gain maps) and the largest is the one that bounds
 * what the renderer must hold. Scanning is confined to `meta` so the coded
 * image data can never be mistaken for a box header.
 */
function readAvifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasSignature(bytes, FTYP_TYPE, 4) || bytes.length < 12) return null;
  if (!AVIF_BRANDS.has(String.fromCharCode(...bytes.subarray(8, 12)))) return null;

  const view = viewOf(bytes);
  let offset = 0;
  let meta: Uint8Array | null = null;
  while (meta === null) {
    const box = readBoxHeader(bytes, view, offset);
    if (box === null) return null;
    if (box.type === "meta") meta = bytes.subarray(offset, Math.min(box.end, bytes.length));
    offset = box.end;
  }

  const metaView = viewOf(meta);
  let largest: ImageDimensions | null = null;
  // The type is followed by four bytes of version and flags, then the extent.
  for (let index = 0; index + ISPE_FIELD_BYTES <= meta.length; index += 1) {
    if (!hasSignature(meta, ISPE_TYPE, index)) continue;
    const size = { width: metaView.getUint32(index + 8), height: metaView.getUint32(index + 12) };
    if (largest === null || size.width * size.height > largest.width * largest.height) {
      largest = size;
    }
  }
  return largest;
}

/**
 * The dimensions `bytes` declares, or null if its container is not one this
 * recognizes or the header is not within the bytes given.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return (
    readPngDimensions(bytes) ??
    readGifDimensions(bytes) ??
    readWebpDimensions(bytes) ??
    readBmpDimensions(bytes) ??
    readAvifDimensions(bytes) ??
    readJpegDimensions(bytes)
  );
}

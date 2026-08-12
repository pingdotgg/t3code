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
 * The dimensions `bytes` declares, or null if its container is not one this
 * recognizes or the header is not within the bytes given.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return (
    readPngDimensions(bytes) ??
    readGifDimensions(bytes) ??
    readWebpDimensions(bytes) ??
    readJpegDimensions(bytes)
  );
}

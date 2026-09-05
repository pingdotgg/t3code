/**
 * Reads pixel dimensions from the header bytes of a PNG, JPEG, GIF, or WebP
 * file so a client can reserve the exact box before the bytes arrive. Any
 * other format, a truncated header, or a malformed file yields null; callers
 * fall back to measuring after decode.
 */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Enough for every supported header, including JPEG files with an EXIF/ICC prefix. */
export const IMAGE_DIMENSIONS_HEADER_BYTES = 64 * 1024;

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const dimensions = readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const data = view(bytes);
  return { width: data.getUint32(16), height: data.getUint32(20) };
}

function readGif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) return null;
  const data = view(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 16) return null;
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null;
  }
  const data = view(bytes);
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  switch (chunk) {
    case "VP8 ":
      if (bytes.length < 30) return null;
      // Lossy: 14-bit dimensions after the 3-byte frame tag and 3-byte start code.
      return {
        width: data.getUint16(26, true) & 0x3fff,
        height: data.getUint16(28, true) & 0x3fff,
      };
    case "VP8L": {
      if (bytes.length < 25) return null;
      // Lossless: width-1 in bits 0-13 and height-1 in bits 14-27 of the
      // 32 bits after the signature byte.
      const packed = data.getUint32(21, true);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      if (bytes.length < 30) return null;
      // Extended: 24-bit canvas dimensions minus one.
      return {
        width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
        height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
      };
    default:
      return null;
  }
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const data = view(bytes);
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Padding bytes between segments.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start-of-frame markers carry the dimensions; skip the arithmetic-coding
    // and Huffman-table markers that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.getUint16(offset + 5), width: data.getUint16(offset + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    offset += 2 + data.getUint16(offset + 2);
  }
  return null;
}

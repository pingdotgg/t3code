export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Allows several 64 KiB JPEG metadata segments before the dimensions header. */
export const IMAGE_DIMENSIONS_HEADER_BYTES = 256 * 1024;

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
      return {
        width: data.getUint16(26, true) & 0x3fff,
        height: data.getUint16(28, true) & 0x3fff,
      };
    case "VP8L": {
      if (bytes.length < 25) return null;
      const packed = data.getUint32(21, true);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      if (bytes.length < 30) return null;
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
  let rotated = false;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Exclude arithmetic-coding and Huffman-table markers from the frame-header range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = data.getUint16(offset + 5);
      const width = data.getUint16(offset + 7);
      return rotated ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    // TEM and the restart markers stand alone, with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.getUint16(offset + 2);
    // EXIF rotation swaps the displayed axes.
    if (marker === 0xe1 && !rotated) {
      rotated = exifOrientationSwapsAxes(bytes, offset + 4, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return null;
}

function exifOrientationSwapsAxes(bytes: Uint8Array, start: number, end: number): boolean {
  end = Math.min(end, bytes.length);
  if (end - start < 14 || String.fromCharCode(...bytes.subarray(start, start + 4)) !== "Exif") {
    return false;
  }
  const tiff = start + 6;
  const data = view(bytes);
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!littleEndian && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return false;
  const ifd = tiff + data.getUint32(tiff + 4, littleEndian);
  if (ifd + 2 > end) return false;
  const entries = data.getUint16(ifd, littleEndian);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return false;
    if (data.getUint16(entry, littleEndian) === 0x0112) {
      const orientation = data.getUint16(entry + 8, littleEndian);
      return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

import { readImageDimensions } from "@t3tools/shared/imageDimensions";

const ICNS_HEADER_BYTES = 8;
const ICNS_MAGIC = 0x69636e73; // "icns"
const PNG_MAGIC = 0x89504e47; // "\x89PNG"

/**
 * Picks the smallest PNG at least `minSize` wide, else the largest; null when there is none.
 * Returns a copy so the response does not pin the whole `.icns` buffer.
 */
export function extractIcnsPng(bytes: Uint8Array, minSize: number): Uint8Array | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < ICNS_HEADER_BYTES || data.getUint32(0) !== ICNS_MAGIC) return null;
  const end = Math.min(data.getUint32(4), bytes.length);
  let best: { readonly png: Uint8Array; readonly width: number } | null = null;
  for (let offset = ICNS_HEADER_BYTES; offset + ICNS_HEADER_BYTES <= end;) {
    const length = data.getUint32(offset + 4);
    if (length < ICNS_HEADER_BYTES || offset + length > end) break;
    const entry = bytes.subarray(offset + ICNS_HEADER_BYTES, offset + length);
    const isPng = entry.length >= 4 && data.getUint32(offset + ICNS_HEADER_BYTES) === PNG_MAGIC;
    offset += length;
    const width = isPng ? readImageDimensions(entry)?.width : undefined;
    if (width === undefined) continue;
    const isBetter =
      best === null ||
      (best.width < minSize ? width > best.width : width >= minSize && width < best.width);
    if (isBetter) best = { png: entry, width };
  }
  return best?.png.slice() ?? null;
}

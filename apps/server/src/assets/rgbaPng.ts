// @effect-diagnostics nodeBuiltinImport:off - PNG compression uses node:zlib, which Effect does
// not wrap.
import * as NodeZlib from "node:zlib";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, NodeZlib.crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Encodes 8-bit RGBA rows as an unfiltered PNG; deflate runs off the event loop. */
export async function encodeRgbaPng(width: number, height: number, rgba: Uint8Array) {
  const rowBytes = width * 4;
  const scanlines = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  }
  const compressed = await new Promise<Uint8Array>((resolve, reject) =>
    NodeZlib.deflate(scanlines, (error, result) => (error ? reject(error) : resolve(result))),
  );
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of parts) {
    png.set(part, position);
    position += part.length;
  }
  return png;
}

/** True when every pixel matches the first, as in thumbnails saved without a viewport. */
export function isUniformRgba(rgba: Uint8Array) {
  for (let index = 4; index < rgba.length; index += 1) {
    if (rgba[index] !== rgba[index & 3]) return false;
  }
  return true;
}

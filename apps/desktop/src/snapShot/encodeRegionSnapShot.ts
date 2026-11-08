// @effect-diagnostics nodeBuiltinImport:off -- Runs inside the Node-mode capture worker.
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

const deflate = NodeUtil.promisify(NodeZlib.deflate);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WEIGHT_BITS = 10;
const WEIGHT_ONE = 1 << WEIGHT_BITS;

export async function encodeRegionSnapShot(
  shot: { readonly width: number; readonly height: number; readonly pixels: Buffer },
  maxSize: { readonly width: number; readonly height: number },
) {
  const scale = Math.min(maxSize.width / shot.width, maxSize.height / shot.height, 1);
  const width = Math.max(1, Math.round(shot.width * scale));
  const height = Math.max(1, Math.round(shot.height * scale));
  const pixels =
    width === shot.width && height === shot.height
      ? shot.pixels
      : downscaleRgba(shot.pixels, shot.width, shot.height, width, height);
  return { width, height, png: await encodePng(pixels, width, height) };
}

function areaWeights(source: number, target: number) {
  const ratio = source / target;
  const starts = new Int32Array(target);
  const counts = new Int32Array(target);
  const weights: number[] = [];
  for (let index = 0; index < target; index++) {
    const from = index * ratio;
    const to = Math.min(source, from + ratio);
    const first = Math.floor(from);
    const end = Math.min(source, Math.ceil(to));
    starts[index] = first;
    counts[index] = end - first;
    const firstWeight = weights.length;
    let total = 0;
    for (let sample = first; sample < end; sample++) {
      const weight = Math.round(
        ((Math.min(to, sample + 1) - Math.max(from, sample)) / ratio) * WEIGHT_ONE,
      );
      weights.push(weight);
      total += weight;
    }
    weights[firstWeight] = (weights[firstWeight] ?? 0) + WEIGHT_ONE - total;
  }
  return { starts, counts, weights: Int32Array.from(weights) };
}

// Area averaging, one output row at a time so the working set stays in cache.
function downscaleRgba(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Buffer {
  const columns = areaWeights(sourceWidth, width);
  const rows = areaWeights(sourceHeight, height);
  const output = Buffer.allocUnsafe(width * height * 4);
  const sourceStride = sourceWidth * 4;
  const row = new Uint32Array(sourceStride);
  const half = 1 << (WEIGHT_BITS * 2 - 1);
  let rowWeight = 0;
  let out = 0;
  for (let y = 0; y < height; y++) {
    let offset = rows.starts[y]! * sourceStride;
    let weight = rows.weights[rowWeight++]!;
    for (let i = 0; i < sourceStride; i++) row[i] = source[offset + i]! * weight;
    for (let sample = 1; sample < rows.counts[y]!; sample++) {
      offset += sourceStride;
      weight = rows.weights[rowWeight++]!;
      for (let i = 0; i < sourceStride; i++) row[i]! += source[offset + i]! * weight;
    }
    let columnWeight = 0;
    for (let x = 0; x < width; x++) {
      let pixel = columns.starts[x]! * 4;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sample = 0; sample < columns.counts[x]!; sample++, pixel += 4) {
        const factor = columns.weights[columnWeight++]!;
        red += row[pixel]! * factor;
        green += row[pixel + 1]! * factor;
        blue += row[pixel + 2]! * factor;
        alpha += row[pixel + 3]! * factor;
      }
      output[out++] = (red + half) >>> (WEIGHT_BITS * 2);
      output[out++] = (green + half) >>> (WEIGHT_BITS * 2);
      output[out++] = (blue + half) >>> (WEIGHT_BITS * 2);
      output[out++] = (alpha + half) >>> (WEIGHT_BITS * 2);
    }
  }
  return output;
}

async function encodePng(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  let opaque = true;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels + 1;
  const scanlines = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    let out = y * stride;
    let pixel = y * width * 4;
    scanlines[out++] = 0;
    if (!opaque) {
      pixels.copy(scanlines, out, pixel, pixel + width * 4);
      continue;
    }
    for (let x = 0; x < width; x++, pixel += 4) {
      scanlines[out++] = pixels[pixel]!;
      scanlines[out++] = pixels[pixel + 1]!;
      scanlines[out++] = pixels[pixel + 2]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", await deflate(scanlines, { level: 3 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(NodeZlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

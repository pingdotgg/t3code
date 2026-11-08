import * as NodeZlib from "node:zlib";

/** 8-bit RGB pixels, row-major. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Models read screenshots best near these limits; larger ones get downscaled by the provider anyway.
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Decodes the non-interlaced 8 or 16-bit RGB(A) PNGs Spectacle writes. Throws on anything else. */
export const decodePng = (bytes: Uint8Array): RgbImage => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Not a PNG.");
  }
  let offset = 8;
  let header: { width: number; height: number; depth: number; channels: number } | undefined;
  const idat: Array<Uint8Array> = [];
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      const colorType = data[9];
      const depth = data[8]!;
      if ((colorType !== 2 && colorType !== 6) || (depth !== 8 && depth !== 16) || data[12] !== 0) {
        throw new Error("Unsupported PNG format.");
      }
      header = {
        width: new DataView(data.buffer, data.byteOffset).getUint32(0),
        height: new DataView(data.buffer, data.byteOffset).getUint32(4),
        depth,
        channels: colorType === 6 ? 4 : 3,
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!header || header.width === 0 || header.height === 0) throw new Error("PNG has no image.");
  const { width, height, depth, channels } = header;
  const pixelBytes = (channels * depth) / 8;
  const stride = width * pixelBytes;
  const raw = NodeZlib.inflateSync(Buffer.concat(idat));
  if (raw.byteLength < (stride + 1) * height) throw new Error("PNG data is truncated.");

  const out = new Uint8Array(width * height * 3);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  const sampleStep = depth / 8;
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    const filter = raw[start]!;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[start + 1 + index]!;
      const left = index >= pixelBytes ? current[index - pixelBytes]! : 0;
      const up = previous[index]!;
      const upLeft = index >= pixelBytes ? previous[index - pixelBytes]! : 0;
      current[index] = (value + unfilter(filter, left, up, upLeft)) & 0xff;
    }
    for (let column = 0; column < width; column += 1) {
      const source = column * pixelBytes;
      const target = (row * width + column) * 3;
      out[target] = current[source]!;
      out[target + 1] = current[source + sampleStep]!;
      out[target + 2] = current[source + 2 * sampleStep]!;
    }
    [previous, current] = [current, previous];
  }
  return { width, height, data: out };
};

const unfilter = (filter: number, left: number, up: number, upLeft: number) => {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) return left;
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      throw new Error("Invalid PNG filter.");
  }
};

/** Largest size within the model limits that keeps the aspect ratio. Never upscales. */
export const fitScreenshotSize = (width: number, height: number) => {
  const scale = Math.min(
    1,
    MAX_EDGE / Math.max(width, height),
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
};

/** Crops `rect` and area-averages it down to `width` x `height`. */
export const cropAndResize = (
  image: RgbImage,
  rect: PixelRect,
  width: number,
  height: number,
): RgbImage => {
  const out = new Uint8Array(width * height * 3);
  const scaleX = rect.width / width;
  const scaleY = rect.height / height;
  for (let row = 0; row < height; row += 1) {
    const top = rect.y + Math.floor(row * scaleY);
    const bottom = Math.max(top + 1, rect.y + Math.floor((row + 1) * scaleY));
    for (let column = 0; column < width; column += 1) {
      const left = rect.x + Math.floor(column * scaleX);
      const right = Math.max(left + 1, rect.x + Math.floor((column + 1) * scaleX));
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const source = (y * image.width + x) * 3;
          red += image.data[source]!;
          green += image.data[source + 1]!;
          blue += image.data[source + 2]!;
        }
      }
      const count = (bottom - top) * (right - left);
      const target = (row * width + column) * 3;
      out[target] = Math.round(red / count);
      out[target + 1] = Math.round(green / count);
      out[target + 2] = Math.round(blue / count);
    }
  }
  return { width, height, data: out };
};

export const encodePng = (image: RgbImage): Uint8Array => {
  const stride = image.width * 3;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    // Filter 0 per row; the zlib pass does the compressing.
    raw.set(image.data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, image.width);
  headerView.setUint32(4, image.height);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
};

const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  out.set(Buffer.from(type, "latin1"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, NodeZlib.crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
};

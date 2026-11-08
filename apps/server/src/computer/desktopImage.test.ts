import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "@effect/vitest";

import { cropAndResize, decodePng, encodePng, fitScreenshotSize } from "./desktopImage.ts";

const rgb = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
) => {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 3);
  }
  return { width, height, data };
};

/** A 16-bit RGBA PNG whose rows use every filter type, as other encoders write them. */
const filteredRgba16 = () => {
  const width = 2;
  const height = 5;
  const bpp = 8;
  const pixels = Array.from({ length: height }, (_, y) =>
    Uint8Array.from({ length: width * bpp }, (_, i) => (y * 37 + i * 11) & 0xff),
  );
  const raw: Array<number> = [];
  pixels.forEach((row, y) => {
    const previous = pixels[y - 1] ?? new Uint8Array(row.length);
    const filter = y;
    raw.push(filter);
    row.forEach((value, i) => {
      const left = i >= bpp ? row[i - bpp]! : 0;
      const up = previous[i]!;
      const upLeft = i >= bpp ? previous[i - bpp]! : 0;
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) &&
        Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter]!;
      raw.push((value - predictor) & 0xff);
    });
  });
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([16, 6], 8);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(Buffer.from(type, "latin1"), 4);
    out.set(data, 8);
    return out;
  };
  const png = Buffer.concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(Uint8Array.from(raw))),
    chunk("IEND", new Uint8Array()),
  ]);
  // High bytes of red, green and blue; alpha is dropped.
  const expected = pixels.flatMap((row) =>
    Array.from({ length: width }, (_, x) => [row[x * bpp]!, row[x * bpp + 2]!, row[x * bpp + 4]!]),
  );
  return { png, expected: expected.flat() };
};

describe("desktopImage", () => {
  it("round-trips RGB through its own encoder", () => {
    const image = rgb(3, 2, (x, y) => [x * 80, y * 120, 7]);
    expect(decodePng(encodePng(image))).toEqual(image);
  });

  it("decodes every PNG row filter at 16 bits with alpha", () => {
    const { png, expected } = filteredRgba16();
    expect([...decodePng(png).data]).toEqual(expected);
  });

  it("rejects interlaced and palette PNGs", () => {
    const png = encodePng(rgb(1, 1, () => [0, 0, 0]));
    const interlaced = Uint8Array.from(png);
    interlaced[8 + 8 + 12] = 1;
    expect(() => decodePng(interlaced)).toThrow("Unsupported PNG format.");
    const palette = Uint8Array.from(png);
    palette[8 + 8 + 9] = 3;
    expect(() => decodePng(palette)).toThrow("Unsupported PNG format.");
  });

  it("crops and averages pixels when it shrinks", () => {
    const image = rgb(4, 2, (x) => (x % 2 === 0 ? [0, 0, 0] : [200, 100, 50]));
    expect(cropAndResize(image, { x: 0, y: 0, width: 4, height: 2 }, 2, 1).data).toEqual(
      Uint8Array.of(100, 50, 25, 100, 50, 25),
    );
    expect(cropAndResize(image, { x: 1, y: 1, width: 1, height: 1 }, 1, 1).data).toEqual(
      Uint8Array.of(200, 100, 50),
    );
  });

  it.each([
    [1280, 800, { width: 1280, height: 800 }],
    [2560, 1440, { width: 1429, height: 804 }],
    [5120, 1440, { width: 1568, height: 441 }],
  ])("fits %ix%i within the model screenshot limits", (width, height, fitted) => {
    expect(fitScreenshotSize(width, height)).toEqual(fitted);
  });
});

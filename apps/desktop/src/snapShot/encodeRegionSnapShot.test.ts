// @effect-diagnostics nodeBuiltinImport:off -- Decodes the PNG the capture worker writes.
import * as NodeZlib from "node:zlib";

import { expect, it } from "vite-plus/test";

import { encodeRegionSnapShot } from "./encodeRegionSnapShot.ts";

function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const typed = png.subarray(offset + 4, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(NodeZlib.crc32(typed));
    chunks.set(typed.subarray(0, 4).toString("latin1"), typed.subarray(4));
    offset += length + 12;
  }
  const header = chunks.get("IHDR")!;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = header[9] === 6 ? 4 : 3;
  const scanlines = NodeZlib.inflateSync(chunks.get("IDAT")!);
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * (width * channels + 1);
    expect(scanlines[row]).toBe(0);
    pixels.push(...scanlines.subarray(row + 1, row + 1 + width * channels));
  }
  return { width, height, channels, pixels };
}

it("keeps translucent captures as RGBA", async () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]);
  const result = await encodeRegionSnapShot(
    { width: 2, height: 1, pixels },
    { width: 100, height: 100 },
  );
  expect(decodePng(result.png)).toEqual({
    width: 2,
    height: 1,
    channels: 4,
    pixels: [...pixels],
  });
});

it("drops the alpha channel of opaque captures without changing colors", async () => {
  const result = await encodeRegionSnapShot(
    { width: 2, height: 1, pixels: Buffer.from([255, 0, 0, 255, 1, 2, 3, 255]) },
    { width: 100, height: 100 },
  );
  expect(decodePng(result.png)).toEqual({
    width: 2,
    height: 1,
    channels: 3,
    pixels: [255, 0, 0, 1, 2, 3],
  });
});

it("area-averages oversized captures to fit both limits", async () => {
  const red = [255, 0, 0, 255];
  const blue = [0, 0, 255, 255];
  const pixels = Buffer.from([red, blue, red, blue, red, blue, red, blue].flat());
  const result = await encodeRegionSnapShot(
    { width: 4, height: 2, pixels },
    { width: 2, height: 2 },
  );
  expect({ width: result.width, height: result.height }).toEqual({ width: 2, height: 1 });
  expect(decodePng(result.png).pixels).toEqual([128, 0, 128, 128, 0, 128]);
});

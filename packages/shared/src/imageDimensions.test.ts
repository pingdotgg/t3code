import { describe, expect, it } from "vite-plus/test";

import { readImageDimensions } from "./imageDimensions.ts";

function bytes(...parts: ReadonlyArray<number | string | ReadonlyArray<number>>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const c of part) out.push(c.charCodeAt(0));
    else if (typeof part === "number") out.push(part);
    else out.push(...part);
  }
  return Uint8Array.from(out);
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];

describe("readImageDimensions", () => {
  it("reads a PNG IHDR", () => {
    const png = bytes(
      [0x89],
      "PNG",
      [0x0d, 0x0a, 0x1a, 0x0a],
      u32(13),
      "IHDR",
      u32(1600),
      u32(900),
    );
    expect(readImageDimensions(png)).toEqual({ width: 1600, height: 900 });
  });

  it("reads a GIF logical screen", () => {
    expect(readImageDimensions(bytes("GIF89a", u16le(320), u16le(240)))).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("reads a JPEG start-of-frame after an APP segment", () => {
    const app1 = bytes([0xff, 0xe1], u16(2 + 6), "Exif\0\0");
    const sof0 = bytes([0xff, 0xc0], u16(17), [8], u16(1400), u16(720));
    expect(readImageDimensions(bytes([0xff, 0xd8], [...app1], [...sof0]))).toEqual({
      width: 720,
      height: 1400,
    });
  });

  it("swaps the axes for a JPEG whose EXIF orientation rotates it 90 degrees", () => {
    // Big-endian TIFF with one IFD0 entry: tag 0x0112 (orientation), SHORT, count 1, value 6.
    const tiff = [
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00,
      0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    const exif = ["Exif\0\0", tiff] as const;
    const app1 = bytes([0xff, 0xe1], u16(2 + 6 + tiff.length), ...exif);
    const sof0 = bytes([0xff, 0xc0], u16(17), [8], u16(3024), u16(4032));
    expect(readImageDimensions(bytes([0xff, 0xd8], [...app1], [...sof0]))).toEqual({
      width: 3024,
      height: 4032,
    });
    // A later XMP APP1 segment must not clear the rotation.
    const xmp = bytes([0xff, 0xe1], u16(2 + 29), "http://ns.adobe.com/xap/1.0/\0");
    expect(readImageDimensions(bytes([0xff, 0xd8], [...app1], [...xmp], [...sof0]))).toEqual({
      width: 3024,
      height: 4032,
    });
    // Orientation 1 leaves the frame size alone.
    const upright = [...tiff];
    upright[19] = 0x01;
    const app1Upright = bytes([0xff, 0xe1], u16(2 + 6 + upright.length), "Exif\0\0", upright);
    expect(readImageDimensions(bytes([0xff, 0xd8], [...app1Upright], [...sof0]))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it("steps over standalone TEM and restart markers", () => {
    const sof0 = bytes([0xff, 0xc0], u16(17), [8], u16(10), u16(20));
    expect(readImageDimensions(bytes([0xff, 0xd8], [0xff, 0x01], [0xff, 0xd3], [...sof0]))).toEqual(
      { width: 20, height: 10 },
    );
  });

  it("does not mistake a Huffman table marker for a frame", () => {
    const dht = bytes([0xff, 0xc4], u16(4), [0, 0]);
    const sof2 = bytes([0xff, 0xc2], u16(17), [8], u16(10), u16(20));
    expect(readImageDimensions(bytes([0xff, 0xd8], [...dht], [...sof2]))).toEqual({
      width: 20,
      height: 10,
    });
  });

  it("reads each WebP container flavour", () => {
    const riff = (chunk: string, body: ReadonlyArray<number>) =>
      bytes("RIFF", u32(0), "WEBP", chunk, u32(body.length), body);
    // VP8: frame tag (3), start code (3), then 14-bit width and height.
    expect(
      readImageDimensions(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(600)])),
    ).toEqual({ width: 800, height: 600 });
    // VP8L: signature 0x2f, then width-1 (14 bits) and height-1 (14 bits) packed LE.
    const packed = (800 - 1) | ((600 - 1) << 14);
    expect(
      readImageDimensions(
        riff("VP8L", [
          0x2f,
          packed & 0xff,
          (packed >>> 8) & 0xff,
          (packed >>> 16) & 0xff,
          (packed >>> 24) & 0xff,
        ]),
      ),
    ).toEqual({ width: 800, height: 600 });
    // VP8X: flags (4), then 24-bit width-1 and height-1.
    expect(
      readImageDimensions(
        riff("VP8X", [
          0,
          0,
          0,
          0,
          799 & 0xff,
          (799 >> 8) & 0xff,
          0,
          599 & 0xff,
          (599 >> 8) & 0xff,
          0,
        ]),
      ),
    ).toEqual({ width: 800, height: 600 });
  });

  it("returns null for unsupported, truncated, or zero-sized input", () => {
    expect(readImageDimensions(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(readImageDimensions(bytes([0x89], "PNG"))).toBeNull();
    expect(readImageDimensions(bytes("GIF89a", u16le(0), u16le(240)))).toBeNull();
    expect(readImageDimensions(bytes([0xff, 0xd8], [0xff, 0xd9]))).toBeNull();
    expect(readImageDimensions(new Uint8Array())).toBeNull();
  });
});

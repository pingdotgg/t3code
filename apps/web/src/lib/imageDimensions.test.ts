import { describe, expect, it } from "vite-plus/test";

import { readImageDimensions } from "./imageDimensions";

function bytesOf(...parts: (number | number[] | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const character of part) flat.push(character.charCodeAt(0));
    } else if (Array.isArray(part)) {
      flat.push(...part);
    } else {
      flat.push(part);
    }
  }
  return new Uint8Array(flat);
}

const bigEndian32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const littleEndian16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const littleEndian24 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
];
const bigEndian16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(width: number, height: number): Uint8Array {
  return bytesOf(PNG_SIGNATURE, bigEndian32(13), "IHDR", bigEndian32(width), bigEndian32(height));
}

function webp(codec: string, payload: number[]): Uint8Array {
  return bytesOf("RIFF", bigEndian32(0), "WEBP", codec, bigEndian32(payload.length), payload);
}

describe("readImageDimensions", () => {
  it("reads a PNG from its IHDR chunk", () => {
    expect(readImageDimensions(png(16_384, 16_384))).toEqual({ width: 16_384, height: 16_384 });
  });

  it("reads a GIF from its logical screen descriptor", () => {
    expect(
      readImageDimensions(bytesOf("GIF89a", littleEndian16(640), littleEndian16(480), 0, 0)),
    ).toEqual({ width: 640, height: 480 });
  });

  it("reads each of the three WebP codecs", () => {
    // Extended files state the canvas size minus one, after a flag and three
    // reserved bytes.
    expect(
      readImageDimensions(
        webp("VP8X", [0x10, 0, 0, 0, ...littleEndian24(1919), ...littleEndian24(1079)]),
      ),
    ).toEqual({ width: 1920, height: 1080 });

    // Lossy files put 14-bit fields after the frame tag and start code.
    expect(
      readImageDimensions(
        webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...littleEndian16(800), ...littleEndian16(600)]),
      ),
    ).toEqual({ width: 800, height: 600 });

    // Lossless files pack width-1 and height-1 into one word after a signature.
    const packed = (99 & 0x3fff) | ((49 & 0x3fff) << 14);
    expect(
      readImageDimensions(
        webp("VP8L", [
          0x2f,
          packed & 0xff,
          (packed >>> 8) & 0xff,
          (packed >>> 16) & 0xff,
          (packed >>> 24) & 0xff,
          0,
        ]),
      ),
    ).toEqual({ width: 100, height: 50 });
  });

  it("walks JPEG metadata segments to the frame header", () => {
    const app0 = bytesOf(
      0xff,
      0xe0,
      bigEndian16(16),
      Array.from({ length: 14 }, () => 0),
    );
    const sof0 = bytesOf(0xff, 0xc0, bigEndian16(11), 8, bigEndian16(2160), bigEndian16(3840), 0);
    expect(readImageDimensions(bytesOf(0xff, 0xd8, [...app0], [...sof0]))).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it("reads nothing from a container it does not know, or a truncated header", () => {
    expect(readImageDimensions(bytesOf("plain text, not an image"))).toBeNull();
    expect(readImageDimensions(png(4, 4).subarray(0, 20))).toBeNull();
    // A JPEG whose frame header is past the bytes given: unmeasurable, not wrong.
    expect(readImageDimensions(bytesOf(0xff, 0xd8, 0xff, 0xe0, bigEndian16(400), 0, 0))).toBeNull();
  });
});

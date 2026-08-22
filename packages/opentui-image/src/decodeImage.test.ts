import * as NodeBuffer from "node:buffer";

import { describe, expect, it } from "bun:test";

import { decodeImage } from "./decodeImage.ts";

const ONE_PIXEL_PNG = NodeBuffer.Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("decodeImage", () => {
  it("decodes encoded image bytes to a standalone PNG preview", async () => {
    const image = await decodeImage(ONE_PIXEL_PNG);

    expect(image.imageWidth).toBe(1);
    expect(image.imageHeight).toBe(1);
    expect(image.source.subarray(0, 8)).toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(image.source.byteOffset).toBe(0);
    expect(image.source.buffer.byteLength).toBe(image.source.byteLength);
  });

  it("rejects invalid encoded data", async () => {
    await expect(decodeImage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

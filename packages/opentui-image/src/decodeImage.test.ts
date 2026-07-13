import * as NodeBuffer from "node:buffer";

import { describe, expect, it } from "bun:test";

import { decodeImage } from "./decodeImage.ts";

const ONE_PIXEL_PNG = NodeBuffer.Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("decodeImage", () => {
  it("decodes encoded image bytes to exact RGBA pixels", async () => {
    const image = await decodeImage(ONE_PIXEL_PNG);

    expect(image.imageWidth).toBe(1);
    expect(image.imageHeight).toBe(1);
    expect(image.data).toHaveLength(4);
    expect(image.data.byteOffset).toBe(0);
    expect(image.data.buffer.byteLength).toBe(image.data.byteLength);
  });

  it("rejects invalid encoded data", async () => {
    await expect(decodeImage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

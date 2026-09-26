import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vite-plus/test";

import { fitClaudeImage } from "./claudeImageSize.ts";

function png(width: number, height: number, alpha: number, colorType: 0 | 6 = 6) {
  const image = new PNG({ width, height });
  image.data.fill(alpha);
  return PNG.sync.write(image, { colorType });
}

describe("fitClaudeImage", () => {
  it("leaves an image within 2000px untouched", () => {
    const bytes = png(2000, 1200, 255);
    expect(fitClaudeImage("image/png", bytes)).toBe(bytes);
  });

  it("scales a tall phone screenshot to 2000px and keeps its transparency", () => {
    const fitted = fitClaudeImage("image/png", png(1080, 2424, 128));
    const decoded = PNG.sync.read(Buffer.from(fitted));
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 891, height: 2000 });
    expect(decoded.data[3]).toBe(128);
  });

  it("keeps a grayscale PNG grayscale", () => {
    const decoded = PNG.sync.read(Buffer.from(fitClaudeImage("image/png", png(2400, 100, 90, 0))));
    expect({ width: decoded.width, colorType: decoded.colorType }).toEqual({
      width: 2000,
      colorType: 0,
    });
  });

  it("scales a wide JPEG and keeps its EXIF orientation", () => {
    const { data } = jpeg.encode(
      {
        width: 3000,
        height: 1000,
        data: new Uint8Array(3000 * 1000 * 4).fill(200),
        // EXIF with orientation 6 (rotate 90° clockwise).
        exifBuffer: Buffer.from([
          0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00,
          0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00,
        ]),
      } as Parameters<typeof jpeg.encode>[0],
      90,
    );
    // Orientation 6 swaps the reported sides.
    expect(readImageDimensions(fitClaudeImage("image/jpeg", data))).toEqual({
      width: 667,
      height: 2000,
    });
  });

  it("passes an oversized GIF through", () => {
    // GIF89a header, 2000x2001.
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xd0, 0x07, 0xd1, 0x07]);
    expect(fitClaudeImage("image/gif", gif)).toBe(gif);
  });
});

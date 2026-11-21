import { describe, expect, it } from "vite-plus/test";

import { prepareImageForAttachment } from "./imageCompression";

// Pure Display P3 green, outside sRGB: an sRGB round trip clamps it to color(display-p3 0.46 0.98 0.33).
const P3_GREEN = "color(display-p3 0 1 0)";

async function makeDisplayP3Png(width: number, height: number): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { colorSpace: "display-p3" });
  if (!context) throw new Error("no 2d context");
  context.fillStyle = P3_GREEN;
  context.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new File([blob], "p3-shot.png", { type: "image/png" });
}

async function readDisplayP3Pixel(file: Blob): Promise<number[]> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { colorSpace: "display-p3" });
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, 1, 1);
  bitmap.close();
  return Array.from(context.getImageData(0, 0, 1, 1, { colorSpace: "display-p3" }).data);
}

describe("prepareImageForAttachment color", () => {
  it("keeps Display P3 colors when it downscales a wide-gamut screenshot", async () => {
    const source = await makeDisplayP3Png(2400, 1600);
    expect(await readDisplayP3Pixel(source)).toEqual([0, 255, 0, 255]);

    const result = await prepareImageForAttachment(source, 20 * 1024 * 1024);
    if (!result.ok) throw new Error(result.reason);
    expect(result.recompressed).toBe(true);
    expect(result.imageSize).toEqual({ width: 2000, height: 1333 });

    const [red, green, blue] = await readDisplayP3Pixel(result.file);
    expect({ red, green, blue }).toEqual({ red: 0, green: 255, blue: 0 });
  });
});

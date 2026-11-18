import { expect, it, vi } from "vite-plus/test";

import { createAnimationFrameSheet } from "./imageAnimation";

it("decodes GIF frames into numbered sheet cells with their original timing and pixels", async () => {
  const gif = new Uint8Array([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255, 33, 249, 4, 0, 10, 0, 0, 0,
    44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 33, 249, 4, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0,
    1, 0, 0, 2, 2, 76, 1, 0, 59,
  ]);
  const sheet = await createAnimationFrameSheet(
    new Blob([gif], { type: "image/gif" }),
    "animation.gif",
  );
  expect(sheet.frames.map(({ number, durationMs }) => ({ number, durationMs }))).toEqual([
    { number: 1, durationMs: 100 },
    { number: 2, durationMs: 200 },
  ]);
  expect(sheet.file.name).toBe("animation-frames.png");
  expect(sheet.context).toContain("1: 100, 2: 200");
  const bitmap = await createImageBitmap(sheet.file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const colors = sheet.frames.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data]);
  expect(colors).toEqual([
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
});

it("rejects a real 65-frame GIF before decoding a contact sheet", async () => {
  const header = [71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255];
  const frame = [33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0];
  const bytes = new Uint8Array([...header, ...Array.from({ length: 65 }, () => frame).flat(), 59]);
  await expect(
    createAnimationFrameSheet(new Blob([bytes], { type: "image/gif" }), "many.gif"),
  ).rejects.toThrow("GIF frame editing supports animations with 1–64 frames.");
});

it("reports unsupported decoding without reading the image bytes", async () => {
  const previous = Reflect.get(globalThis, "ImageDecoder");
  vi.stubGlobal("ImageDecoder", undefined);
  using _decoder = { [Symbol.dispose]: () => vi.stubGlobal("ImageDecoder", previous) };
  const blob = new Blob();
  using bytes = vi.spyOn(blob, "arrayBuffer");
  await expect(createAnimationFrameSheet(blob, "image.gif")).rejects.toThrow(
    "GIF frame editing requires a browser with ImageDecoder support",
  );
  expect(bytes).not.toHaveBeenCalled();
});

it("rejects oversized GIF sources before allocating their bytes", async () => {
  const blob = new Blob();
  Object.defineProperty(blob, "size", { value: 32 * 1024 * 1024 + 1 });
  using bytes = vi.spyOn(blob, "arrayBuffer");
  await expect(createAnimationFrameSheet(blob, "large.gif")).rejects.toThrow(
    "GIF frame editing supports images up to 32 MB.",
  );
  expect(bytes).not.toHaveBeenCalled();
});

it.each([
  { width: 8001, height: 8000, count: 1, error: "This GIF has unsupported frame dimensions." },
  { width: 8000, height: 8000, count: 2, error: "This GIF is too large to edit as a frame sheet." },
])(
  "closes the decoder and first frame when rejecting $width×$height×$count",
  async ({ width, height, count, error }) => {
    const previous = Reflect.get(globalThis, "ImageDecoder");
    const closeFrame = vi.fn();
    const closeDecoder = vi.fn();
    const decode = vi.fn(async () => ({
      image: { displayWidth: width, displayHeight: height, close: closeFrame },
    }));
    vi.stubGlobal(
      "ImageDecoder",
      class {
        static isTypeSupported = async () => true;
        tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: count } };
        decode = decode;
        close = closeDecoder;
      },
    );
    using _decoder = { [Symbol.dispose]: () => vi.stubGlobal("ImageDecoder", previous) };
    await expect(createAnimationFrameSheet(new Blob(), "large.gif")).rejects.toThrow(error);
    expect(decode).toHaveBeenCalledOnce();
    expect(closeFrame).toHaveBeenCalledOnce();
    expect(closeDecoder).toHaveBeenCalledOnce();
  },
);

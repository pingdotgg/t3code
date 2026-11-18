import { expect, it } from "vite-plus/test";
import {
  addImageEditorObject,
  createImageEditorDocument,
  setImageEditorCrop,
} from "./imageEditorDocument";
import { exportEditorImage, loadEditorImage } from "./imageEditorExport";

async function pixels(file: File) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas context");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    width: canvas.width,
    height: canvas.height,
    at: (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data],
  };
}

it("exports cropped originals, visual overlays, and exact black/white brush masks in the same coordinate frame", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="#00ff00"/></svg>';
  const image = await loadEditorImage(`data:image/svg+xml,${encodeURIComponent(source)}`);
  let document = setImageEditorCrop(createImageEditorDocument(12, 8), {
    x: 2,
    y: 1,
    width: 8,
    height: 6,
  });
  document = addImageEditorObject(document, {
    id: "remove",
    kind: "remove",
    x: 4,
    y: 2,
    width: 1,
    height: 2,
    rotation: 0,
    color: "#123456",
    strokeWidth: 2,
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 2 },
    ],
  });
  document = addImageEditorObject(document, {
    id: "box",
    kind: "rectangle",
    x: 8,
    y: 4,
    width: 2,
    height: 2,
    rotation: 0,
    color: "#0000ff",
    strokeWidth: 2,
  });

  const original = await exportEditorImage(image, document, "source.jpg", { mode: "original" });
  const guidance = await exportEditorImage(image, document, "source.jpg", { mode: "annotated" });
  const mask = await exportEditorImage(image, document, "source.jpg", { mode: "mask" });
  const [originalPixels, guidancePixels, maskPixels] = await Promise.all([
    pixels(original),
    pixels(guidance),
    pixels(mask),
  ]);
  for (const result of [originalPixels, guidancePixels, maskPixels]) {
    expect(result.width).toBe(8);
    expect(result.height).toBe(6);
  }
  expect(original.name).toBe("source-original.png");
  expect(guidance.type).toBe("image/png");
  expect(originalPixels.at(2, 2)).toEqual([0, 255, 0, 255]);
  expect(guidancePixels.at(2, 2)[0]).toBeGreaterThan(100);
  expect(guidancePixels.at(6, 3)).toEqual([0, 0, 255, 255]);
  expect(maskPixels.at(2, 2)).toEqual([255, 255, 255, 255]);
  expect(maskPixels.at(6, 3)).toEqual([0, 0, 0, 255]);
  expect(maskPixels.at(0, 5)).toEqual([0, 0, 0, 255]);
});

it("preserves transparent and partial-alpha pixels when exporting a cropped original", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect x="4" y="2" width="4" height="4" fill="#ff0000" fill-opacity="0.5"/></svg>';
  const image = await loadEditorImage(`data:image/svg+xml,${encodeURIComponent(source)}`);
  const document = setImageEditorCrop(createImageEditorDocument(12, 8), {
    x: 2,
    y: 1,
    width: 8,
    height: 6,
  });
  const result = await pixels(await exportEditorImage(image, document, "alpha.svg"));
  expect([result.width, result.height]).toEqual([8, 6]);
  expect(result.at(0, 0)).toEqual([0, 0, 0, 0]);
  expect(result.at(3, 2)[3]).toBe(128);
});

it.each([
  { width: 16_385, height: 1 },
  { width: 1, height: 16_385 },
  { width: 8000, height: 4001 },
])(
  "rejects unsafe $width×$height output before creating a large canvas",
  async ({ width, height }) => {
    const image = await loadEditorImage(
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    );
    await expect(
      exportEditorImage(image, createImageEditorDocument(width, height), "large.png"),
    ).rejects.toThrow("This image is too large to export.");
  },
);

it("rejects corrupt image bytes with a recoverable decode error", async () => {
  await expect(loadEditorImage("data:image/png;base64,bm90IGEgcG5n")).rejects.toThrow(
    "This image could not be decoded for editing.",
  );
});

import { expect, it } from "vite-plus/test";
import { decodeImagePreview } from "./decodeImagePreview";
import tiff from "./test-fixtures/decode.tif?url";
import heic from "./test-fixtures/decode.heic?url";
it.each([
  ["TIFF", tiff, false],
  ["HEIC", heic, true],
] as const)("decodes real %s bytes", async (_kind, src, heif) => {
  const blob = await decodeImagePreview(src, heif, new AbortController().signal);
  const bitmap = await createImageBitmap(blob);
  expect(bitmap.width).toBe(32);
  expect(bitmap.height).toBe(48);
  bitmap.close();
});

import { describe, expect, it } from "vite-plus/test";

import { inferImageExtension } from "./imageMime.ts";

describe("imageMime", () => {
  it("maps known image mime types to extensions", () => {
    expect(inferImageExtension({ mimeType: "image/png" })).toBe(".png");
    expect(inferImageExtension({ mimeType: "image/jpeg" })).toBe(".jpg");
    expect(inferImageExtension({ mimeType: "IMAGE/WEBP" })).toBe(".webp");
  });

  it("falls back to a safe file name extension", () => {
    expect(inferImageExtension({ mimeType: "image/unknown", fileName: "shot.PNG" })).toBe(".png");
  });

  it("falls back to .bin when nothing safe matches", () => {
    expect(inferImageExtension({ mimeType: "image/unknown", fileName: "shot.exe" })).toBe(".bin");
  });

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });
});

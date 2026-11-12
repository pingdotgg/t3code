import { describe, expect, it } from "vite-plus/test";

import { imageMimeType, isSvgAttachment } from "./image.ts";

describe("isSvgAttachment", () => {
  it("recognizes SVG previews without promoting them to provider images", () => {
    for (const mimeType of [
      "image/svg+xml",
      "IMAGE/SVG+XML; charset=utf-8",
      "",
      "application/octet-stream",
    ]) {
      const attachment = { name: "diagram.SVG", mimeType };
      expect(isSvgAttachment(attachment)).toBe(true);
      expect(imageMimeType(attachment)).toBeNull();
    }
    expect(isSvgAttachment({ name: "diagram.svg", mimeType: "application/pdf" })).toBe(false);
    expect(isSvgAttachment({ name: "photo.png", mimeType: "image/png" })).toBe(false);
  });
});

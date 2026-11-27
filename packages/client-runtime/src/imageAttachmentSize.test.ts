import { describe, expect, it } from "vite-plus/test";

import {
  IMAGE_ATTACHMENT_MAX_EDGE,
  downscalableImageMimeType,
  fitImageAttachmentSize,
} from "./imageAttachmentSize.ts";

describe("downscalableImageMimeType", () => {
  it.each([
    ["image/png", "image/png"],
    ["image/jpeg", "image/jpeg"],
    ["image/jpg", "image/jpeg"],
    ["IMAGE/PNG", "image/png"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(downscalableImageMimeType(input)).toBe(expected);
  });

  it.each(["image/gif", "image/webp", "text/plain"])("rejects %s", (input) => {
    expect(downscalableImageMimeType(input)).toBeNull();
  });
});

describe("fitImageAttachmentSize", () => {
  it("returns null when the image already fits", () => {
    expect(fitImageAttachmentSize({ width: 800, height: 600 })).toBeNull();
    expect(
      fitImageAttachmentSize({
        width: IMAGE_ATTACHMENT_MAX_EDGE,
        height: IMAGE_ATTACHMENT_MAX_EDGE,
      }),
    ).toBeNull();
  });

  it("scales the longest edge down to the limit", () => {
    expect(fitImageAttachmentSize({ width: 4000, height: 2000 })).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it("clamps the short edge of extreme aspect ratios to at least 1px", () => {
    expect(fitImageAttachmentSize({ width: 1, height: 10000 })).toEqual({
      width: 1,
      height: IMAGE_ATTACHMENT_MAX_EDGE,
    });
  });
});

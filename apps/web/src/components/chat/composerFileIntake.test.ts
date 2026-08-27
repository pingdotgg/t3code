import { PROVIDER_SEND_TURN_MAX_VIDEO_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isInlineAttachableFile } from "./composerFileIntake";

describe("isInlineAttachableFile", () => {
  it("accepts supported images and videos", () => {
    expect(isInlineAttachableFile({ type: "image/png", size: 1024 })).toBe(true);
    expect(isInlineAttachableFile({ type: "video/mp4", size: 1024 })).toBe(true);
  });

  it("routes unsupported file types to path references", () => {
    expect(isInlineAttachableFile({ type: "text/csv", size: 1024 })).toBe(false);
    expect(isInlineAttachableFile({ type: "application/pdf", size: 1024 })).toBe(false);
    // Dropped from some file managers with no detected type at all.
    expect(isInlineAttachableFile({ type: "", size: 1024 })).toBe(false);
  });

  it("routes unsupported media variants to path references", () => {
    expect(isInlineAttachableFile({ type: "image/heic", size: 1024 })).toBe(false);
    expect(isInlineAttachableFile({ type: "video/x-msvideo", size: 1024 })).toBe(false);
  });

  it("routes empty or oversized videos to path references", () => {
    expect(isInlineAttachableFile({ type: "video/mp4", size: 0 })).toBe(false);
    expect(
      isInlineAttachableFile({ type: "video/mp4", size: PROVIDER_SEND_TURN_MAX_VIDEO_BYTES + 1 }),
    ).toBe(false);
  });
});

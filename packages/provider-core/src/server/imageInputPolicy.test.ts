import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import { shouldSendNativeImage } from "./imageInputPolicy.ts";

const png = {
  type: "image",
  mimeType: "image/png",
} as ChatAttachment;

const pdf = {
  type: "file",
  mimeType: "application/pdf",
} as ChatAttachment;

describe("shouldSendNativeImage", () => {
  it("blocks a valid image when the model is known to lack vision", () => {
    expect(shouldSendNativeImage({ attachment: png, supportsImageInput: false })).toBe(false);
  });

  it("preserves native images for vision models", () => {
    expect(shouldSendNativeImage({ attachment: png, supportsImageInput: true })).toBe(true);
  });

  it("preserves existing behavior for unknown capabilities", () => {
    expect(shouldSendNativeImage({ attachment: png, supportsImageInput: undefined })).toBe(true);
  });

  it("never promotes an ordinary file into a native image", () => {
    expect(shouldSendNativeImage({ attachment: pdf, supportsImageInput: true })).toBe(false);
  });
});

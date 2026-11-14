import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import { modelImageInputSupport, shouldSendNativeImage } from "./imageInputPolicy.ts";

const png = {
  type: "image",
  mimeType: "image/png",
} as ChatAttachment;

const pdf = {
  type: "file",
  mimeType: "application/pdf",
} as ChatAttachment;

describe("modelImageInputSupport", () => {
  it.each([
    [{ capabilities: { input: { image: false } } }, false],
    [{ capabilities: { input: { image: true } } }, true],
    [{ input: ["text"] }, false],
    [{ input: ["text", "image"] }, true],
    [{ modalities: { input: ["text"] } }, false],
    [{ modalities: { input: ["text", "image"] } }, true],
    [{}, undefined],
    [undefined, undefined],
  ] as const)("detects image modality support from provider metadata", (model, expected) => {
    expect(modelImageInputSupport(model)).toBe(expected);
  });
});

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

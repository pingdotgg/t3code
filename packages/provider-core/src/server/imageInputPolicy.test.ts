import { assert, describe, it } from "@effect/vitest";
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
    assert.equal(modelImageInputSupport(model), expected);
  });
});

describe("shouldSendNativeImage", () => {
  it("blocks a valid image when the model is known to lack vision", () => {
    assert.isFalse(shouldSendNativeImage({ attachment: png, supportsImageInput: false }));
  });

  it("preserves native images for vision models", () => {
    assert.isTrue(shouldSendNativeImage({ attachment: png, supportsImageInput: true }));
  });

  it("preserves existing behavior for unknown capabilities", () => {
    assert.isTrue(shouldSendNativeImage({ attachment: png, supportsImageInput: undefined }));
  });

  it("never promotes an ordinary file into a native image", () => {
    assert.isFalse(shouldSendNativeImage({ attachment: pdf, supportsImageInput: true }));
  });
});

import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerAttachmentAccept,
  validateComposerAttachment,
} from "./composerAttachmentValidation";

describe("validateComposerAttachment", () => {
  it("limits the native picker to images for providers with an image-only transport", () => {
    expect(composerAttachmentAccept(ProviderDriverKind.make("codex"))).toBe("image/*");
    expect(composerAttachmentAccept(ProviderDriverKind.make("hermes"))).toBeUndefined();
  });

  it("preserves images for every provider", () => {
    expect(
      validateComposerAttachment(
        { name: "shot.png", size: 12, type: "image/png" },
        ProviderDriverKind.make("codex"),
      ),
    ).toMatchObject({ accepted: true, type: "image" });
  });

  it.each([
    ["report.pdf", "application/pdf", "pdf"],
    ["clip.webm", "video/webm", "video"],
    ["notes.txt", "text/plain", "file"],
  ] as const)("accepts Hermes %s", (name, mimeType, type) => {
    expect(
      validateComposerAttachment(
        { name, size: 12, type: mimeType },
        ProviderDriverKind.make("hermes"),
      ),
    ).toMatchObject({ accepted: true, type });
  });

  it.each([
    ["report.pdf", "pdf"],
    ["clip.webm", "video"],
    ["notes.txt", "file"],
  ] as const)("infers a safe MIME type for Hermes %s when the browser omits it", (name, type) => {
    expect(
      validateComposerAttachment({ name, size: 12, type: "" }, ProviderDriverKind.make("hermes")),
    ).toMatchObject({ accepted: true, type });
  });

  it("rejects non-image files for providers without a transport", () => {
    expect(
      validateComposerAttachment(
        { name: "notes.txt", size: 12, type: "text/plain" },
        ProviderDriverKind.make("codex"),
      ),
    ).toMatchObject({ accepted: false, message: expect.stringContaining("only in Hermes") });
  });

  it.each([
    ["image", "shot.png", "image/png", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES],
    ["file", "archive.zip", "application/zip", PROVIDER_SEND_TURN_MAX_FILE_BYTES],
  ] as const)("enforces the exact %s byte limit", (_kind, name, type, maxBytes) => {
    const provider = ProviderDriverKind.make("hermes");
    expect(validateComposerAttachment({ name, size: maxBytes, type }, provider)).toMatchObject({
      accepted: true,
    });
    expect(validateComposerAttachment({ name, size: maxBytes + 1, type }, provider)).toMatchObject({
      accepted: false,
      message: expect.stringContaining(`${maxBytes / (1024 * 1024)}MB`),
    });
  });

  it.each([
    ["voice.mp3", "audio/mpeg", "sound input path"],
    ["../secret.txt", "text/plain", "safe, plain file names"],
    ["unknown", "", "trustworthy MIME type"],
  ] as const)("rejects unsafe or unsupported %s honestly", (name, type, message) => {
    expect(
      validateComposerAttachment({ name, size: 12, type }, ProviderDriverKind.make("hermes")),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining(message),
    });
  });
});

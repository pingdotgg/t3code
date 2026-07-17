import { describe, expect, it } from "bun:test";

import {
  imageMimeTypeForPath,
  imageExtensionForMimeType,
  isSupportedImagePath,
  prepareComposerImage,
  prepareComposerImageBytes,
  removeComposerImage,
} from "./composerAttachments.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("composer image attachments", () => {
  it("recognizes supported workspace image paths case-insensitively", () => {
    expect(isSupportedImagePath("docs/diagram.PNG")).toBe(true);
    expect(imageMimeTypeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(imageExtensionForMimeType("image/png")).toBe("png");
    expect(imageExtensionForMimeType("image/jpeg;charset=binary")).toBe("jpg");
    expect(isSupportedImagePath("README.md")).toBe(false);
  });

  it("builds an upload attachment and bounded RGBA preview", async () => {
    const decoded = {
      data: new Uint8Array([255, 0, 0, 255]),
      imageWidth: 1,
      imageHeight: 1,
    };
    let decodedBytes = 0;
    const image = await prepareComposerImage(
      "docs/diagram.png",
      {
        contents: PNG_BASE64,
        byteLength: 68,
        truncated: false,
      },
      async (encoded) => {
        decodedBytes = encoded.byteLength;
        return decoded;
      },
    );

    expect(decodedBytes).toBe(68);
    expect(image.relativePath).toBe("docs/diagram.png");
    expect(image.upload).toEqual({
      type: "image",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 68,
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(image.preview).toBe(decoded);
  });

  it("Given clipboard image bytes, when prepared, then they use the same bounded upload path", async () => {
    const encoded = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
    const preview = {
      data: new Uint8Array([255, 0, 0, 255]),
      imageWidth: 1,
      imageHeight: 1,
    };
    const image = await prepareComposerImageBytes(
      "clipboard-image-1.png",
      "image/png",
      encoded,
      async () => preview,
    );

    expect(image.relativePath).toBe("clipboard-image-1.png");
    expect(image.upload).toEqual({
      type: "image",
      name: "clipboard-image-1.png",
      mimeType: "image/png",
      sizeBytes: 68,
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(image.preview).toBe(preview);
  });

  it("rejects truncated, empty, and malformed image payloads", async () => {
    const decoder = async () => ({
      data: new Uint8Array([0, 0, 0, 0]),
      imageWidth: 1,
      imageHeight: 1,
    });
    await expect(
      prepareComposerImage(
        "large.png",
        { contents: "AA==", byteLength: 11 * 1024 * 1024, truncated: true },
        decoder,
      ),
    ).rejects.toThrow("10MB");
    await expect(
      prepareComposerImage("empty.png", { contents: "", byteLength: 0, truncated: false }, decoder),
    ).rejects.toThrow("empty");
    await expect(
      prepareComposerImage(
        "bad.png",
        { contents: "not-base64", byteLength: 3, truncated: false },
        decoder,
      ),
    ).rejects.toThrow("base64");
  });

  it("Given a staged image, when it is removed, then the outgoing attachment list omits it", () => {
    const preview = {
      data: new Uint8Array([255, 0, 0, 255]),
      imageWidth: 1,
      imageHeight: 1,
    };
    const image = {
      relativePath: "docs/diagram.png",
      upload: {
        type: "image" as const,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,AA==",
      },
      preview,
    };

    expect(removeComposerImage([image], image.relativePath)).toEqual([]);
  });
});

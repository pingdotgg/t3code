import { describe, expect, it } from "vite-plus/test";

import {
  decodeBase64ImagePayload,
  imageMimeType,
  isSvgAttachment,
  sniffImageMimeType,
  validateAndNormalizeImageBytes,
} from "./image.ts";

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const VALID_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const VALID_GIF89A_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const VALID_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

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

describe("sniffImageMimeType", () => {
  it("identifies common raster image formats by magic bytes", () => {
    expect(sniffImageMimeType(VALID_PNG_BYTES)).toBe("image/png");
    expect(sniffImageMimeType(VALID_JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageMimeType(VALID_GIF89A_BYTES)).toBe("image/gif");
    expect(sniffImageMimeType(VALID_WEBP_BYTES)).toBe("image/webp");
    expect(sniffImageMimeType(new TextEncoder().encode("not an image"))).toBeNull();
  });
});

describe("validateAndNormalizeImageBytes", () => {
  it("accepts raw binary images matching declared MIME type", () => {
    expect(
      validateAndNormalizeImageBytes({ bytes: VALID_PNG_BYTES, declaredMimeType: "image/png" }),
    ).toEqual({
      ok: true,
      bytes: VALID_PNG_BYTES,
      mimeType: "image/png",
      decodedFromBase64: false,
    });
    expect(
      validateAndNormalizeImageBytes({ bytes: VALID_JPEG_BYTES, declaredMimeType: "image/jpg" }),
    ).toEqual({
      ok: true,
      bytes: VALID_JPEG_BYTES,
      mimeType: "image/jpeg",
      decodedFromBase64: false,
    });
  });

  it("decodes data URL and plain base64 payloads that decode to valid images", () => {
    const base64Png = Buffer.from(VALID_PNG_BYTES).toString("base64");
    const dataUrlBytes = new TextEncoder().encode(`data:image/png;base64,${base64Png}\n`);
    const plainBase64Bytes = new TextEncoder().encode(base64Png);

    expect(
      validateAndNormalizeImageBytes({ bytes: dataUrlBytes, declaredMimeType: "image/png" }),
    ).toEqual({
      ok: true,
      bytes: VALID_PNG_BYTES,
      mimeType: "image/png",
      decodedFromBase64: true,
    });
    expect(
      validateAndNormalizeImageBytes({ bytes: plainBase64Bytes, declaredMimeType: "image/png" }),
    ).toEqual({
      ok: true,
      bytes: VALID_PNG_BYTES,
      mimeType: "image/png",
      decodedFromBase64: true,
    });
  });

  it("rejects mismatched MIME types and non-image payloads without false positives", () => {
    expect(
      validateAndNormalizeImageBytes({ bytes: VALID_JPEG_BYTES, declaredMimeType: "image/png" }),
    ).toMatchObject({ ok: false });

    const validBase64OfText = new TextEncoder().encode(
      Buffer.from("hello world, not an image").toString("base64"),
    );
    expect(decodeBase64ImagePayload(validBase64OfText)).toBeNull();
    expect(
      validateAndNormalizeImageBytes({ bytes: validBase64OfText, declaredMimeType: "image/png" }),
    ).toMatchObject({ ok: false });

    const mismatchedDataUrl = new TextEncoder().encode(
      `data:image/jpeg;base64,${Buffer.from(VALID_PNG_BYTES).toString("base64")}`,
    );
    expect(
      validateAndNormalizeImageBytes({ bytes: mismatchedDataUrl, declaredMimeType: "image/png" }),
    ).toMatchObject({ ok: false });
  });
});

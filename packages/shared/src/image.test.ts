import { describe, expect, it } from "vite-plus/test";

import { imageMimeType } from "./image.ts";

describe("imageMimeType", () => {
  it("recognizes a picture the file picker left untyped", () => {
    expect(imageMimeType({ name: "IMG_4997.PNG", mimeType: "" })).toBe("image/png");
    expect(imageMimeType({ name: "shot.jpg", mimeType: "application/octet-stream" })).toBe(
      "image/jpeg",
    );
  });

  it("trusts a declared supported type", () => {
    expect(imageMimeType({ name: "no-extension", mimeType: "image/webp" })).toBe("image/webp");
    expect(imageMimeType({ name: "x.png", mimeType: "image/png; charset=binary" })).toBe(
      "image/png",
    );
  });

  it("leaves images the provider cannot accept as files", () => {
    expect(imageMimeType({ name: "scan.heic", mimeType: "image/heic" })).toBeNull();
    expect(imageMimeType({ name: "logo.svg", mimeType: "image/svg+xml" })).toBeNull();
  });

  it("leaves documents and videos alone", () => {
    expect(imageMimeType({ name: "notes.txt", mimeType: "text/plain" })).toBeNull();
    expect(imageMimeType({ name: "clip.mp4", mimeType: "video/mp4" })).toBeNull();
    expect(imageMimeType({ name: "noext", mimeType: "" })).toBeNull();
  });
});

describe("legacy attachments", () => {
  it("recognizes a picture that was sent before pictures were typed by content", () => {
    expect(imageMimeType({ name: "IMG_4996.PNG", mimeType: "application/octet-stream" })).toBe(
      "image/png",
    );
    expect(imageMimeType({ name: "1000000020.png", mimeType: "" })).toBe("image/png");
  });
});

describe("a declared non-image type", () => {
  it("wins over a misleading picture extension", () => {
    expect(imageMimeType({ name: "report.png", mimeType: "application/pdf" })).toBeNull();
    expect(imageMimeType({ name: "archive.jpg", mimeType: "application/zip" })).toBeNull();
    expect(imageMimeType({ name: "clip.png", mimeType: "video/mp4" })).toBeNull();
  });

  it("still falls back when the type is absent or generic", () => {
    expect(imageMimeType({ name: "IMG_4996.PNG", mimeType: "application/octet-stream" })).toBe(
      "image/png",
    );
    expect(imageMimeType({ name: "1000000020.png", mimeType: "" })).toBe("image/png");
  });
});

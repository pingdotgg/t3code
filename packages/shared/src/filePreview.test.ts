import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspaceFontPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  mediaKindFromPath,
  officePreviewKind,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each([
    ["zip", "archive", "application/zip"],
    ["jar", "archive", "application/java-archive"],
    ["tar", "archive", "application/x-tar"],
    ["gz", "archive", "application/gzip"],
    ["tgz", "archive", "application/gzip"],
    ["sqlite", "sqlite", "application/vnd.sqlite3"],
    ["sqlite3", "sqlite", "application/vnd.sqlite3"],
    ["db", "sqlite", "application/vnd.sqlite3"],
  ])("recognizes binary preview %s", (extension, kind, mimeType) => {
    const name = `files#draft/sample.${extension.toUpperCase()}`;
    expect(filePreviewKind({ name, mimeType: "application/octet-stream" })).toBe(kind);
    expect(filePreviewKind({ name: "download", mimeType })).toBe(kind);
    expect(isWorkspacePreviewEntryPath(name)).toBe(true);
    expect(isWorkspacePreviewEntryPath(`${name}?download=1`)).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(`.${extension}`)).toBe(mimeType);
  });
  it("recognizes compound archives and MIME aliases", () => {
    expect(filePreviewKind({ name: "archive.tar.gz" })).toBe("archive");
    expect(filePreviewKind({ name: "download", mimeType: "application/x-gzip" })).toBe("archive");
    expect(filePreviewKind({ name: "download", mimeType: "application/x-sqlite3" })).toBe("sqlite");
    expect(filePreviewKind({ name: "misleading.zip", mimeType: "application/pdf" })).toBe("pdf");
  });
  it.each(["ttf", "otf", "woff", "woff2"])(
    "previews %s fonts through signed host assets",
    (extension) => {
      expect(
        filePreviewKind({ name: `sample.${extension}`, mimeType: "application/octet-stream" }),
      ).toBe("font");
      expect(filePreviewKind({ name: "download", mimeType: `font/${extension}` })).toBe("font");
      expect(isWorkspaceFontPreviewPath(`/tmp/sample.${extension.toUpperCase()}`)).toBe(true);
      expect(isWorkspacePreviewEntryPath(`sample.${extension}`)).toBe(true);
      expect(hostPreviewMimeTypeFromExtension(`.${extension}`)).toBe(`font/${extension}`);
      expect(isWorkspaceFontPreviewPath(`sample.${extension}?download=1`)).toBe(false);
      expect(filePreviewKind({ name: `sample.${extension}`, mimeType: "application/zip" })).toBe(
        "archive",
      );
    },
  );
  it.each([
    [
      "quarterly-report.DOCX",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "finance#q4/operating-plan.xlsx",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "slides?review/quarterly-review.pptx",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ])("recognizes Office assets at literal path %s", (name, kind, mimeType) => {
    expect(officePreviewKind({ name })).toBe(kind);
    expect(filePreviewKind({ name, mimeType: "application/octet-stream" })).toBe(kind);
    expect(isWorkspacePreviewEntryPath(name)).toBe(true);
    expect(hostPreviewMimeTypeFromExtension(`.${kind}`)).toBe(mimeType);
    expect(filePreviewKind({ name: "download", mimeType })).toBe(kind);
    expect(filePreviewKind({ name, mimeType: "application/zip" })).toBe("archive");
  });
  // regression: #10311 previews classify by the literal filename, not URL-like suffixes
  it.each([
    "image.png.ts",
    "image.png#notes.txt",
    "image%2Epng",
    "report.docx#notes.txt",
    "report.xlsx?download=1",
    "slides%2Epptx",
    "report.docm",
    "slides.ppt",
  ])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it.each(["picture.bmp", "photo.heic", "photo.heif", "scan.tif", "scan.TIFF"])(
    "recognizes image preview path %s",
    (path) => {
      expect(isWorkspaceImagePreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it("serves audio in place from the host like video and browser documents", () => {
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".weba")).toBe("audio/webm");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".constructor")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".toString")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".__proto__")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".webm-audio")).toBe("audio/webm");
  });
});

describe("media path parsing", () => {
  // regression: #9023 media kind comes from the decoded pathname, ignoring query and hash
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result.png%23secret.txt", null],
    ["/tmp/tone.MP3", "audio"],
    ["./tone.wav", "audio"],
    ["tone.ogg", "audio"],
    ["tone.m4a", "audio"],
    ["tone.flac", "audio"],
    ["tone.aac", "audio"],
    ["tone.opus", "audio"],
    ["tone.webm-audio", "audio"],
    ["tone.webm", "video"],
    ["https://example.com/tone%2Emp3?download=1", "audio"],
    ["data.csv", null],
    ["report.pdf", null],
    ["report.docx", null],
    ["archive.zip", null],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["diagram.mmd", "", "mermaid"],
    ["diagram.MERMAID", "text/plain", "mermaid"],
    ["download", "text/vnd.mermaid", "mermaid"],
    ["source-code.otf", "application/vnd.oasis.opendocument.formula-template", "font"],
    ["notes.rtf", "application/rtf", "text"],
    ["notes.rtf", "", "text"],
    ["clip.weba", "", "audio"],
    ["image.bmp", "application/octet-stream", "image"],
    ["photo.heic", "application/octet-stream", "image"],
    ["scan.tiff", "application/octet-stream", "image"],
    ["recording.mp3", "", "audio"],
    ["recording.webm-audio", "", "audio"],
    ["recording.webm", "audio/webm", "audio"],
    ["payload", "application/problem+json", "text"],
    ["archive.zip", "application/zip", "archive"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "archive"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it.each(["doc", "xls", "ppt", "odt", "ods", "odp", "epub", "7z", "rar"])(
    "retains the binary fallback for %s, which opencode does not render",
    (extension) => {
      expect(filePreviewKind({ name: `sample.${extension}` })).toBe("unsupported");
    },
  );
  it("does not corrupt a multi-byte character at the preview boundary", () => {
    const bytes = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES - 1] = 0xe2;
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES] = 0x82;
    const preview = decodeFilePreviewText(bytes);
    expect(preview.truncated).toBe(true);
    expect(preview.text.endsWith("�")).toBe(false);
    expect(preview.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES - 1);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspace3DPreviewPath,
  isWorkspaceAudioPreviewPath,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  mediaKindFromPath,
  modelPreviewFormat,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each([
    [".FBX", "fbx", "application/octet-stream"],
    [".GLB", "gltf", "model/gltf-binary"],
    [".gltf", "gltf", "model/gltf+json"],
    [".OBJ", "obj", "model/obj"],
    [".stl", "stl", "model/stl"],
    [".ply", "ply", "application/octet-stream"],
  ])("recognizes models with extension %s", (extension, format, mime) => {
    const path = `Models/car${extension}`;
    expect(isWorkspace3DPreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    expect(modelPreviewFormat(path)).toBe(format);
    expect(hostPreviewMimeTypeFromExtension(extension)).toBe(mime);
    expect(modelPreviewFormat(`${path}.meta`)).toBeNull();
  });

  it.each(["material.mtl", "buffer.bin", "model.blend", "model.obj?download=1"])(
    "keeps companion files and unsupported models out of the viewer: %s",
    (path) => {
      expect(modelPreviewFormat(path)).toBeNull();
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
      expect(hostPreviewMimeTypeFromExtension(path.slice(path.lastIndexOf(".")))).toBeNull();
    },
  );
  it("serves FBX models without changing audio or document classification", () => {
    expect(isWorkspace3DPreviewPath("Models/car.FBX")).toBe(true);
    expect(isWorkspacePreviewEntryPath("Models/car.FBX")).toBe(true);
    expect(isWorkspace3DPreviewPath("car.fbx.meta")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".FBX")).toBe("application/octet-stream");
    expect(hostPreviewMimeTypeFromExtension(".html")).toBe("text/html");
    expect(hostPreviewMimeTypeFromExtension(".wav")).toBe("audio/wav");
  });

  it.each(["report.html", "report.HTM", "document#draft.pdf", "reports?old/document.pdf"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector#mark.svg",
    "photo?edited.JPEG",
    "images#archive/icon.png",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each([
    "README.md",
    "src/index.ts",
    "image.png.ts",
    "png",
    "image.png#notes.txt",
    "image.svg?notes.txt",
    "document.pdf?download=1",
    "report.html#notes.txt",
    "image%2Epng",
  ])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it("serves audio in place from the host like video and browser documents", () => {
    expect(isWorkspaceAudioPreviewPath("notes/recording.WAV")).toBe(true);
    expect(isWorkspaceAudioPreviewPath("recording.wav.ts")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
  });
});

describe("media path parsing", () => {
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["https://example.png", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result%23v2.png", "image"],
    ["images/result.png%23secret.txt", null],
    ["images/result.png%3Fsecret.txt", null],
    ["/tmp/100%.png", "image"],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });

  it.each([
    ["recording.mp4#t=2", "video", false],
    ["recording%2Emp4", "video", false],
    ["recording#take2.mp4", null, true],
    ["recording?take2.mp4", null, true],
  ])("distinguishes authored URLs from literal filenames in %s", (source, kind, literalVideo) => {
    expect(mediaKindFromPath(source)).toBe(kind);
    expect(isWorkspaceVideoPreviewPath(source)).toBe(literalVideo);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["README.md", "text/plain", "markdown"],
    ["component.tsx", "", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["recording.mp3", "", "audio"],
    ["payload", "application/problem+json", "text"],
    ["archive.zip", "application/zip", "unsupported"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "unsupported"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
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

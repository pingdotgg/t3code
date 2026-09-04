import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  mediaKindFromPath,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
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
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );
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

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  markdownMediaFileName,
  resolveMarkdownMediaSource,
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

  it.each(["recording.mp4", "capture.WEBM", "clip.mov?download=1"])(
    "recognizes video preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it("classifies direct markdown media without asset resolution", () => {
    expect(
      resolveMarkdownMediaSource("https://cdn.example/preview.png", ThreadId.make("thread-1")),
    ).toEqual({
      _tag: "Direct",
      url: "https://cdn.example/preview.png",
    });
  });

  it("scopes relative markdown media to the thread worktree", () => {
    expect(
      resolveMarkdownMediaSource("./tmp/evidence%20capture.png?cache=1", ThreadId.make("thread-1")),
    ).toEqual({
      _tag: "Asset",
      resource: {
        _tag: "workspace-file",
        threadId: "thread-1",
        path: "tmp/evidence capture.png",
      },
    });
  });

  it.each([
    "/tmp/userdata/browser-artifacts/browser-recording-1.webm",
    "C:\\t3\\userdata\\browser-artifacts\\browser-recording-1.webm",
    "/C:/t3/userdata/browser-artifacts/browser-recording-1.webm",
  ])("resolves absolute browser artifact path %s", (path) => {
    expect(resolveMarkdownMediaSource(path, ThreadId.make("thread-1"))).toEqual({
      _tag: "Asset",
      resource: {
        _tag: "browser-artifact",
        fileName: "browser-recording-1.webm",
      },
    });
  });

  it("does not treat a relative browser-artifacts directory as the artifact store", () => {
    expect(
      resolveMarkdownMediaSource(
        "docs/browser-artifacts/browser-recording-1.webm",
        ThreadId.make("thread-1"),
      ),
    ).toEqual({
      _tag: "Asset",
      resource: {
        _tag: "workspace-file",
        threadId: "thread-1",
        path: "docs/browser-artifacts/browser-recording-1.webm",
      },
    });
  });

  it("derives a decoded media file name without query or fragment", () => {
    expect(markdownMediaFileName("tmp/evidence%20capture.png?cache=1#preview")).toBe(
      "evidence capture.png",
    );
    expect(markdownMediaFileName("C:\\tmp\\evidence%20capture.png")).toBe("evidence capture.png");
  });
});

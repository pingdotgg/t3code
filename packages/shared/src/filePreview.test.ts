import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceExternalOpenPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  workspaceExternalOpenMimeType,
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

describe("workspace external-open files", () => {
  it.each(["scene.glb", "models/robot.GLB"])("maps %s to the GLB handoff MIME type", (path) => {
    expect(isWorkspaceExternalOpenPath(path)).toBe(true);
    expect(workspaceExternalOpenMimeType(path)).toBe("model/gltf-binary");
    // External-open files never join the inline preview surfaces.
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it.each([
    "scene.gltf",
    "scene.glb.ts",
    "glb",
    ".glb",
    "models/.glb",
    "scene.glb.bak",
    // Literal filenames keep their query-looking suffixes; not GLB files.
    "model.glb?download=1",
    "secrets.glb?x",
  ])("rejects non-external-open path %s", (path) => {
    expect(isWorkspaceExternalOpenPath(path)).toBe(false);
    expect(workspaceExternalOpenMimeType(path)).toBeNull();
  });
});

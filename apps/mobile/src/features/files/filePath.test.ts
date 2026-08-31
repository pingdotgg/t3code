import { describe, expect, it } from "vite-plus/test";

import {
  isBrowserPreviewFile,
  isExternalOpenFile,
  isImagePreviewFile,
  isSvgImagePreviewFile,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveWorkspaceRelativeFilePath", () => {
  it("keeps normalized workspace-relative paths", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "./src/../src/main.ts")).toBe("src/main.ts");
  });

  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("file preview types", () => {
  it("recognizes browser and image previews", () => {
    expect(isBrowserPreviewFile("reports/summary.html")).toBe(true);
    expect(isImagePreviewFile("assets/icon.png")).toBe(true);
    expect(isImagePreviewFile("assets/diagram.SVG?raw=1")).toBe(true);
    expect(isImagePreviewFile("src/image.ts")).toBe(false);
  });

  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });

  it("identifies external-open files that skip the text readFile path", () => {
    // Extension policy lives in @t3tools/shared/filePreview and is covered
    // there; this pins the Android-only platform gate.
    expect(isExternalOpenFile("models/scene.glb", "android")).toBe(true);
    expect(isExternalOpenFile("models/scene.glb", "ios")).toBe(false);
    expect(isExternalOpenFile("src/main.ts", "android")).toBe(false);
  });
});

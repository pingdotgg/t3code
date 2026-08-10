import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownImageFile } from "./markdown-images";

describe("resolveMarkdownImageFile", () => {
  it("resolves workspace-relative image sources against the thread cwd", () => {
    expect(resolveMarkdownImageFile("artifacts/features.png", "/workspace/project")).toEqual({
      path: "/workspace/project/artifacts/features.png",
      name: "features.png",
    });
  });

  it("keeps absolute image paths for server-side asset resolution", () => {
    expect(
      resolveMarkdownImageFile(
        "/workspace/project/screenshots/cache-prices.webp",
        "/workspace/project",
      ),
    ).toEqual({
      path: "/workspace/project/screenshots/cache-prices.webp",
      name: "cache-prices.webp",
    });
  });

  it("supports file URLs and decodes their path", () => {
    expect(
      resolveMarkdownImageFile(
        "file:///workspace/project/screenshots/privacy%20details.png",
        "/workspace/project",
      ),
    ).toEqual({
      path: "/workspace/project/screenshots/privacy details.png",
      name: "privacy details.png",
    });
  });

  it("leaves remote images and non-image files alone", () => {
    expect(
      resolveMarkdownImageFile("https://example.com/screenshot.png", "/workspace/project"),
    ).toBe(null);
    expect(resolveMarkdownImageFile("docs/report.md", "/workspace/project")).toBe(null);
  });
});

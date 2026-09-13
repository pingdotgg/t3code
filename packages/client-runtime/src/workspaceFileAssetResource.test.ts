import { describe, expect, it } from "vite-plus/test";
import { workspaceFileAssetResource } from "./workspaceFileAssetResource.ts";

describe("workspaceFileAssetResource", () => {
  it.each([
    ["/primary", "image.png", "image.png"],
    ["/primary", "/primary/docs/preview.html", "docs/preview.html"],
    ["/member-checkout", "/member-checkout/report.pdf", "report.pdf"],
    ["/primary", "/primary-other/image.png", "/primary-other/image.png"],
    ["/primary", "/primary/../outside/clip.mp4", "/primary/../outside/clip.mp4"],
    ["/primary", "/primary/docs/../audio.wav", "audio.wav"],
    ["C:\\Primary", "c:\\primary\\docs\\preview.html", "docs/preview.html"],
    ["C:\\Primary", "D:\\Other\\image.png", "D:\\Other\\image.png"],
    ["\\\\host\\share\\repo", "\\\\host\\share\\repo\\image.png", "image.png"],
  ])("serves %s / %s without a conversation record", (cwd, path, expectedPath) => {
    expect(workspaceFileAssetResource({ cwd, path })).toEqual({
      _tag: "draft-workspace-file",
      cwd,
      path: expectedPath,
    });
  });

  it("keeps identical filenames in different checkouts distinct", () => {
    expect(workspaceFileAssetResource({ cwd: "/primary", path: "image.png" })).not.toEqual(
      workspaceFileAssetResource({ cwd: "/member", path: "image.png" }),
    );
  });

  it.each([null, undefined, ""])("does not resolve without cwd (%s)", (cwd) => {
    expect(workspaceFileAssetResource({ cwd, path: "/image.png" })).toBeNull();
  });
  it("does not resolve without a selected path", () => {
    expect(workspaceFileAssetResource({ cwd: "/primary", path: null })).toBeNull();
  });
});

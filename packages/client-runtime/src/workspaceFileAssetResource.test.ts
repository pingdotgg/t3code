import { describe, expect, it } from "vite-plus/test";
import { workspaceFileAssetResource } from "./workspaceFileAssetResource.ts";

describe("workspaceFileAssetResource", () => {
  it.each([
    ["/primary", "image.png", "image.png"],
    ["/primary", "/primary/docs/preview.html", "docs/preview.html"],
    ["/member-checkout", "/member-checkout/report.pdf", "report.pdf"],
    ["/primary", "/primary-other/image.png", "/primary-other/image.png"],
    ["/primary", "/primary/../outside/clip.mp4", "/primary/../outside/clip.mp4"],
    ["/primary", "/primary/docs/../audio.wav", "/primary/docs/../audio.wav"],
    ["/primary", "clip.mp4", "/primary/clip.mp4"],
    ["/primary/", "audio.wav", "/primary/audio.wav"],
    ["/", "audio.wav", "/audio.wav"],
    ["/primary", "../outside/audio.wav", "/primary/../outside/audio.wav"],
    ["C:\\Primary", "clips/demo.mp4", "C:\\Primary\\clips\\demo.mp4"],
    ["C:/Primary/", "clips\\demo.mp4", "C:/Primary/clips/demo.mp4"],
    ["C:\\Primary", "D:\\Other\\audio.wav", "D:\\Other\\audio.wav"],
    ["C:\\Primary", "c:\\primary\\..\\audio.wav", "c:\\primary\\..\\audio.wav"],
    ["\\\\host\\share\\repo\\", "clips/demo.mp4", "\\\\host\\share\\repo\\clips\\demo.mp4"],
    ["/primary", "\\\\host\\share\\audio.wav", "\\\\host\\share\\audio.wav"],
    ["//host/share/repo", "audio.wav", "//host/share/repo/audio.wav"],
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

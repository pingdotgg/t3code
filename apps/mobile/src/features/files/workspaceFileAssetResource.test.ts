import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { workspaceFileAssetResource } from "./workspaceFileAssetResource";

describe("workspace file preview resources", () => {
  it("loads empty-task previews using the explicit primary root without a fake thread", () => {
    expect(
      workspaceFileAssetResource({
        cwd: "/primary",
        explicitCwd: "/primary",
        threadId: null,
        relativePath: "preview.html",
      }),
    ).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/primary",
      path: "preview.html",
    });
  });
  it("retains a review file's member checkout even with a task context", () => {
    expect(
      workspaceFileAssetResource({
        cwd: "/member",
        explicitCwd: "/member",
        threadId: ThreadId.make("member"),
        relativePath: "image.png",
      }),
    ).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/member",
      path: "image.png",
    });
  });
  it("makes absolute in-root HTML relative so its sibling assets remain available", () => {
    expect(
      workspaceFileAssetResource({
        cwd: "/primary",
        explicitCwd: "/member",
        threadId: null,
        relativePath: "/member/docs/preview.html",
      }),
    ).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/member",
      path: "docs/preview.html",
    });
  });
  it("preserves old thread media links and their exact absolute path", () => {
    expect(
      workspaceFileAssetResource({
        cwd: "/member",
        threadId: ThreadId.make("member"),
        relativePath: "/tmp/clip.mp4",
      }),
    ).toEqual({
      _tag: "media-file",
      threadId: "member",
      path: "/tmp/clip.mp4",
    });
  });
});

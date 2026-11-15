// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  isServableVideo,
  listVideoFolder,
  LOCAL_MEDIA_PATHNAME,
  resolveMediaRequest,
} from "./LocalVideoMedia.ts";

const mediaUrl = (file: string) =>
  new URL(`t3code://app${LOCAL_MEDIA_PATHNAME}?path=${encodeURIComponent(file)}`);

describe("LocalVideoMedia", () => {
  it("serves only videos directly inside a chosen folder", () => {
    const folders = new Set(["/videos"]);
    expect(isServableVideo("/videos/space.mp4", folders)).toBe(true);
    expect(isServableVideo("/videos/SPACE.WEBM", folders)).toBe(true);
    expect(isServableVideo("/videos/notes.txt", folders)).toBe(false);
    expect(isServableVideo("/videos/nested/space.mp4", folders)).toBe(false);
    expect(isServableVideo("/videos/../etc/space.mp4", folders)).toBe(false);
    expect(isServableVideo("/other/space.mp4", folders)).toBe(false);
    expect(isServableVideo("videos/space.mp4", folders)).toBe(false);
  });

  it("lists a folder's videos and allows only that folder", async () => {
    const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-videos-"));
    const other = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-other-"));
    try {
      await NodeFSP.writeFile(NodePath.join(folder, "b.webm"), "");
      await NodeFSP.writeFile(NodePath.join(folder, "a.mp4"), "");
      await NodeFSP.writeFile(NodePath.join(folder, "readme.md"), "");
      await NodeFSP.mkdir(NodePath.join(folder, "clip.mp4"));
      await NodeFSP.writeFile(NodePath.join(other, "c.mp4"), "");

      expect(resolveMediaRequest(mediaUrl(NodePath.join(folder, "a.mp4")))).toBeNull();
      expect(await listVideoFolder(folder)).toEqual({ folder, files: ["a.mp4", "b.webm"] });
      expect(resolveMediaRequest(mediaUrl(NodePath.join(folder, "a.mp4")))).toBe(
        NodePath.join(folder, "a.mp4"),
      );
      expect(resolveMediaRequest(mediaUrl(NodePath.join(other, "c.mp4")))).toBeNull();
      expect(
        resolveMediaRequest(new URL(`t3code://app/elsewhere?path=${folder}/a.mp4`)),
      ).toBeNull();
    } finally {
      await NodeFSP.rm(folder, { recursive: true, force: true });
      await NodeFSP.rm(other, { recursive: true, force: true });
    }
  });
});

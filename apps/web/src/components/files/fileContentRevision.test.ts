import { describe, expect, it } from "vite-plus/test";

import {
  fileContentRevision,
  projectFileCacheKey,
  projectFileEditorCacheKey,
} from "./fileContentRevision";

describe("fileContentRevision", () => {
  it("changes for same-length edits", () => {
    expect(fileContentRevision("nodeVersion")).not.toBe(fileContentRevision("nodeVeasdrs"));
  });

  it("keeps identical contents stable", () => {
    expect(projectFileCacheKey("/repo", "file.json", "contents")).toBe(
      projectFileCacheKey("/repo", "file.json", "contents"),
    );
  });

  it("keeps editor identity stable while contents change", () => {
    const cacheKey = projectFileEditorCacheKey("/repo", "file.json");

    expect(cacheKey).toBe(projectFileEditorCacheKey("/repo", "file.json"));
    expect(cacheKey).not.toBe(projectFileEditorCacheKey("/repo", "other.json"));
  });
});

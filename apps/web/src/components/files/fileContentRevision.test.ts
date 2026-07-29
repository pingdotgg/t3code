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

  it("keeps editor identity stable for locally edited contents", () => {
    const cacheKey = projectFileEditorCacheKey("local", "/repo", "file.json", "after", undefined);

    expect(
      projectFileEditorCacheKey("local", "/repo", "file.json", "after edit", {
        cacheKey,
        contents: "after edit",
      }),
    ).toBe(cacheKey);
  });

  it("rotates editor identity for external contents and environments", () => {
    const cacheKey = projectFileEditorCacheKey("local", "/repo", "file.json", "before", undefined);
    const editorFile = { cacheKey, contents: "before" };

    expect(
      projectFileEditorCacheKey("local", "/repo", "file.json", "external edit", editorFile),
    ).not.toBe(cacheKey);
    expect(projectFileEditorCacheKey("remote", "/repo", "file.json", "before", undefined)).not.toBe(
      cacheKey,
    );
  });
});

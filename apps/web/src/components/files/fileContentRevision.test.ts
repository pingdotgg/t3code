import { describe, expect, it } from "vite-plus/test";

import { projectFileCacheKey } from "./fileContentRevision";

describe("file cache identity", () => {
  it("changes for same-length edits", () => {
    expect(projectFileCacheKey("/repo", "file.json", "nodeVersion")).not.toBe(
      projectFileCacheKey("/repo", "file.json", "nodeVeasdrs"),
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import { getReviewFilePatchLookahead } from "./reviewFilePatchDemand";

const files = Array.from({ length: 30 }, (_, index) => ({
  path: `file-${index}.ts`,
  previousPath: null,
  additions: 1,
  deletions: 1,
}));

describe("getReviewFilePatchLookahead", () => {
  it("preserves default expanded viewport lookahead", () => {
    expect(getReviewFilePatchLookahead(files, 0, undefined)).toEqual([
      "file-0.ts",
      "file-1.ts",
      "file-2.ts",
    ]);
  });

  it("does not request collapsed files or scan past the lookahead window", () => {
    expect(getReviewFilePatchLookahead(files, 10, ["file-11.ts", "file-20.ts"])).toEqual([
      "file-11.ts",
    ]);
    expect(getReviewFilePatchLookahead(files, 0, [])).toEqual([]);
  });

  it("keeps a requested path valid when another file is inserted before it", () => {
    const requested = getReviewFilePatchLookahead(files, 10, ["file-10.ts"]);
    const updated = [{ ...files[0]!, path: "earlier.ts" }, ...files];

    expect(
      updated.filter((file) => requested.includes(file.path)).map((file) => file.path),
    ).toEqual(["file-10.ts"]);
  });

  it("bounds the window at the last file and ignores missing selections", () => {
    expect(getReviewFilePatchLookahead(files, 29, undefined)).toEqual(["file-29.ts"]);
    expect(getReviewFilePatchLookahead(files, -1, undefined)).toEqual([]);
  });
});

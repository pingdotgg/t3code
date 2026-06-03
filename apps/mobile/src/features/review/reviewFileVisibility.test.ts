import { describe, expect, it } from "vite-plus/test";

import {
  getDefaultReviewExpandedFileIds,
  getValidExplicitReviewFileIds,
  getValidReviewFileIds,
  removeReviewFileId,
  toggleReviewFileId,
} from "./reviewFileVisibility";
import type { ReviewRenderableFile } from "./reviewModel";

function makeFile(id: string): ReviewRenderableFile {
  return {
    id,
    cacheKey: id,
    path: id,
    previousPath: null,
    changeType: "change",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
  };
}

describe("review file visibility", () => {
  const files = [makeFile("a.ts"), makeFile("b.ts")];

  it("defaults expanded files to every renderable file", () => {
    expect(getDefaultReviewExpandedFileIds(files)).toEqual(["a.ts", "b.ts"]);
    expect(getValidReviewFileIds(files, undefined)).toEqual(["a.ts", "b.ts"]);
  });

  it("filters stale cached file ids", () => {
    expect(getValidReviewFileIds(files, ["missing.ts", "b.ts"])).toEqual(["b.ts"]);
    expect(getValidExplicitReviewFileIds(files, undefined)).toEqual([]);
    expect(getValidExplicitReviewFileIds(files, ["a.ts", "missing.ts"])).toEqual(["a.ts"]);
  });

  it("toggles and removes ids without mutating the original array", () => {
    const original = ["a.ts"];

    expect(toggleReviewFileId(original, "b.ts")).toEqual(["a.ts", "b.ts"]);
    expect(toggleReviewFileId(original, "a.ts")).toEqual([]);
    expect(removeReviewFileId(original, "a.ts")).toEqual([]);
    expect(original).toEqual(["a.ts"]);
  });
});

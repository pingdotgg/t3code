import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isFileDiffFoldedByDefault,
  isLineInFileDiff,
  setFileDiffFold,
  setFileViewedFold,
} from "./pullRequestDiff.logic";

function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
): FileDiffMetadata {
  return { name: "src/app.ts", hunks } as unknown as FileDiffMetadata;
}

describe("isLineInFileDiff", () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it("includes the first line of a hunk and excludes the one past its last", () => {
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });
});

describe("isFileDiffFoldedByDefault", () => {
  it("folds a viewed file every time the diff is drawn", () => {
    expect(
      isFileDiffFoldedByDefault({ foldOverride: null, filesCollapsedSetting: false, viewed: true }),
    ).toBe(true);
    expect(
      isFileDiffFoldedByDefault({
        foldOverride: null,
        filesCollapsedSetting: false,
        viewed: false,
      }),
    ).toBe(false);
  });

  it("lets the toolbar fold or unfold every file, viewed or not", () => {
    expect(
      isFileDiffFoldedByDefault({
        foldOverride: "expanded",
        filesCollapsedSetting: true,
        viewed: true,
      }),
    ).toBe(false);
    expect(
      isFileDiffFoldedByDefault({
        foldOverride: "folded",
        filesCollapsedSetting: false,
        viewed: false,
      }),
    ).toBe(true);
  });
});

describe("setFileViewedFold", () => {
  // regression: a tick after Expand all must not hold the file shut once it stops being viewed
  it("folds a ticked file only while it stays viewed", () => {
    const folds = setFileViewedFold("a.ts", true, new Set());
    const input = { foldOverride: "expanded", filesCollapsedSetting: false } as const;
    expect(
      isFileDiffFoldedByDefault({ ...input, viewed: true, viewedFold: folds.has("a.ts") }),
    ).toBe(true);
    expect(
      isFileDiffFoldedByDefault({ ...input, viewed: false, viewedFold: folds.has("a.ts") }),
    ).toBe(false);
  });

  it("drops the fold on untick and keeps the same set when nothing changes", () => {
    const folds = setFileViewedFold("a.ts", true, new Set());
    expect(setFileViewedFold("a.ts", true, folds)).toBe(folds);
    expect(setFileViewedFold("a.ts", false, folds).size).toBe(0);
  });
});

describe("isFileDiffCollapsed", () => {
  // regression: #9174 diffs now expand by default; a reader's fold must survive new slices
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const choices = new Map([["b.ts", true]]);
    expect(isFileDiffCollapsed("b.ts", false, choices)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", false, choices)).toBe(false);
  });

  it("keeps a viewed file the reader opened open when a push unmarks it", () => {
    const choices = setFileDiffFold("a.ts", false, true, new Map());
    expect(isFileDiffCollapsed("a.ts", true, choices)).toBe(false);
    expect(isFileDiffCollapsed("a.ts", false, choices)).toBe(false);
  });
});

describe("setFileDiffFold", () => {
  it("drops a choice that agrees with the default so the file follows it again", () => {
    const opened = setFileDiffFold("a.ts", false, true, new Map());
    expect([...opened]).toEqual([["a.ts", false]]);
    expect(setFileDiffFold("a.ts", true, true, opened).size).toBe(0);
  });

  it("folds a file ticked after the toolbar unfolded everything", () => {
    expect([...setFileDiffFold("a.ts", true, false, new Map())]).toEqual([["a.ts", true]]);
  });

  it("keeps the same map when nothing changes", () => {
    const choices = new Map([["a.ts", true]]);
    expect(setFileDiffFold("a.ts", true, false, choices)).toBe(choices);
    expect(setFileDiffFold("b.ts", false, false, choices)).toBe(choices);
  });
});

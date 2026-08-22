import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  getPullRequestFileLoadState,
  isFileDiffCollapsed,
  isLineInFileDiff,
} from "./pullRequestDiff.logic";

/** Only the hunk ranges matter here; the viewer fills the rest in when it renders. */
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

  it("places a line inside a hunk, on the side that hunk counts", () => {
    expect(isLineInFileDiff(file, "right", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 11)).toBe(true);
  });

  it("includes the first line of a hunk and excludes the one past its last", () => {
    // The boundaries are where an off-by-one would quietly move a conversation between lists.
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    // The second hunk is a pure insertion: it deletes nothing, so nothing is on its left.
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });

  it("places nothing in a file whose hunks the host withheld", () => {
    expect(isLineInFileDiff(fileWithHunks([]), "right", 1)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  const NO_TOGGLES: ReadonlySet<string> = new Set();

  it("opens every file when the preference is expanded", () => {
    // Pressing the toolbar clears the reader's own toggles, which is why the set is empty here.
    expect(isFileDiffCollapsed("a.ts", "expanded", NO_TOGGLES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", "expanded", NO_TOGGLES)).toBe(false);
  });

  it("folds every file again on the second press", () => {
    expect(isFileDiffCollapsed("a.ts", "folded", NO_TOGGLES)).toBe(true);
    expect(isFileDiffCollapsed("b.ts", "folded", NO_TOGGLES)).toBe(true);
  });

  it("keeps a file the reader folded folded as the next slice arrives", () => {
    // The file keys grow with every slice, so the answer for one already folded must not depend on
    // how many of them there are by then.
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", "expanded", toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", "expanded", toggled)).toBe(false);
  });

  it("still answers to a toggle after either toolbar press", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", new Set(["a.ts"]))).toBe(true);
    expect(isFileDiffCollapsed("a.ts", "folded", new Set(["a.ts"]))).toBe(false);
  });
});

describe("getPullRequestFileLoadState", () => {
  it("uses a reported total while it is still ahead of the loaded files", () => {
    expect(getPullRequestFileLoadState(2, 80, true)).toEqual({
      displayedFileCount: 80,
      knownTotalFileCount: 80,
      displayedCountIsLowerBound: false,
    });
  });

  it("treats an exhausted reported count as a lower bound while more files remain", () => {
    expect(getPullRequestFileLoadState(1_000, 1_000, true)).toEqual({
      displayedFileCount: 1_000,
      knownTotalFileCount: null,
      displayedCountIsLowerBound: true,
    });
    expect(getPullRequestFileLoadState(1_001, 1_000, true)).toEqual({
      displayedFileCount: 1_001,
      knownTotalFileCount: null,
      displayedCountIsLowerBound: true,
    });
  });

  it("uses the loaded count as a lower bound when the host reports no total", () => {
    expect(getPullRequestFileLoadState(23, null, true)).toEqual({
      displayedFileCount: 23,
      knownTotalFileCount: null,
      displayedCountIsLowerBound: true,
    });
  });
});

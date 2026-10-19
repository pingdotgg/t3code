import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  toggleFileDiffFoldForViewed,
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

  it("places a line inside a hunk, on the side that hunk counts", () => {
    expect(isLineInFileDiff(file, "right", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 11)).toBe(true);
  });

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

  it("places nothing in a file whose hunks the host withheld", () => {
    expect(isLineInFileDiff(fileWithHunks([]), "right", 1)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  const NO_TOGGLES: ReadonlySet<string> = new Set();

  it("opens every file before the reader has touched anything", () => {
    expect(isFileDiffCollapsed("a.ts", null, NO_TOGGLES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", null, NO_TOGGLES)).toBe(false);
  });

  it("opens every file once the toolbar has asked for it", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", NO_TOGGLES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", "expanded", NO_TOGGLES)).toBe(false);
  });

  it("folds every file again on the second press", () => {
    expect(isFileDiffCollapsed("a.ts", "folded", NO_TOGGLES)).toBe(true);
    expect(isFileDiffCollapsed("b.ts", "folded", NO_TOGGLES)).toBe(true);
  });

  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(false);
  });

  it("still answers to a toggle after either toolbar press", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", new Set(["a.ts"]))).toBe(true);
    expect(isFileDiffCollapsed("a.ts", "folded", new Set(["a.ts"]))).toBe(false);
  });
});

describe("toggleFileDiffFoldForViewed", () => {
  it("puts a file away when it is ticked off", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, null, new Set())]).toEqual(["a.ts"]);
  });

  it("brings a file back when the tick is taken off", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", false, null, new Set(["a.ts"]))]).toEqual([]);
  });

  it("leaves the fold alone when it already says what the tick does", () => {
    const folded = new Set(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", true, null, folded)).toBe(folded);
  });

  it("moves against whatever the toolbar last asked for", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, "expanded", new Set())]).toEqual(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", false, "expanded", new Set()).size).toBe(0);
  });

  it("touches only the file that was ticked", () => {
    const toggled = new Set(["a.ts", "b.ts"]);
    expect([...toggleFileDiffFoldForViewed("a.ts", false, null, toggled)]).toEqual(["b.ts"]);
  });
});

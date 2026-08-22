import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  toggleFileDiffFoldForViewed,
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

  it("folds every file before the reader has touched anything", () => {
    expect(isFileDiffCollapsed("a.ts", null, NO_TOGGLES)).toBe(true);
    expect(isFileDiffCollapsed("b.ts", null, NO_TOGGLES)).toBe(true);
  });

  it("opens every file once the toolbar has asked for it", () => {
    // Pressing the toolbar clears the reader's own toggles, which is why the set is empty here.
    expect(isFileDiffCollapsed("a.ts", "expanded", NO_TOGGLES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", "expanded", NO_TOGGLES)).toBe(false);
  });

  it("folds every file again on the second press", () => {
    expect(isFileDiffCollapsed("a.ts", "folded", NO_TOGGLES)).toBe(true);
    expect(isFileDiffCollapsed("b.ts", "folded", NO_TOGGLES)).toBe(true);
  });

  it("keeps a file the reader opened open as the next slice arrives", () => {
    // The file keys grow with every slice, so the answer for one already open must not depend on
    // how many of them there are by then.
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(false);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(true);
  });

  it("still answers to a toggle after either toolbar press", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", new Set(["a.ts"]))).toBe(true);
    expect(isFileDiffCollapsed("a.ts", "folded", new Set(["a.ts"]))).toBe(false);
  });
});

describe("toggleFileDiffFoldForViewed", () => {
  it("puts a file away when it is ticked off", () => {
    // Files start folded, so one the reader had opened is the case that has somewhere to go.
    const opened = new Set(["a.ts"]);
    expect([...toggleFileDiffFoldForViewed("a.ts", true, null, opened)]).toEqual([]);
  });

  it("brings a file back when the tick is taken off", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", false, null, new Set())]).toEqual(["a.ts"]);
  });

  it("leaves the fold alone when it already says what the tick does", () => {
    const folded = new Set<string>();
    expect(toggleFileDiffFoldForViewed("a.ts", true, null, folded)).toBe(folded);
  });

  it("moves against whatever the toolbar last asked for", () => {
    // Everything is open, so ticking a file off has to fold that one against the default.
    expect([...toggleFileDiffFoldForViewed("a.ts", true, "expanded", new Set())]).toEqual(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", false, "expanded", new Set()).size).toBe(0);
  });

  it("touches only the file that was ticked", () => {
    const toggled = new Set(["a.ts", "b.ts"]);
    expect([...toggleFileDiffFoldForViewed("a.ts", true, null, toggled)]).toEqual(["b.ts"]);
  });
});

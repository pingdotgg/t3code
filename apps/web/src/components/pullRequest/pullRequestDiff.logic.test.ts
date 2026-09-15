import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  getPullRequestDiffStats,
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

  it("opens every file before the reader has touched anything", () => {
    expect(isFileDiffCollapsed("a.ts", null, NO_TOGGLES)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", null, NO_TOGGLES)).toBe(false);
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

  it("keeps a file the reader folded closed as the next slice arrives", () => {
    // The file keys grow with every slice, so the answer for one already folded must not depend
    // on how many of them there are by then.
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(false);
  });

  it("still answers to a toggle after either toolbar press", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", new Set(["a.ts"]))).toBe(true);
    expect(isFileDiffCollapsed("a.ts", "folded", new Set(["a.ts"]))).toBe(false);
  });
});

describe("getPullRequestDiffStats", () => {
  const file = {
    name: "example.ts",
    hunks: [{ additionLines: 3, deletionLines: 2 }],
  } as FileDiffMetadata;
  it("uses full PR totals before and during page loading", () => {
    const totals = { additions: 1000, deletions: 500, changedFiles: 50 };
    for (const files of [[], [file]]) {
      expect(
        getPullRequestDiffStats({ complete: false, files, omittedFileStats: new Map(), totals }),
      ).toEqual(totals);
    }
  });
  it("does not replace known patch counts with omitted host totals", () => {
    expect(
      getPullRequestDiffStats({
        complete: false,
        files: [file],
        omittedFileStats: new Map(),
        totals: { additions: 0, deletions: 0, changedFiles: 0 },
      }),
    ).toEqual({ additions: 3, deletions: 2, changedFiles: 1 });
  });
  it("uses one snapshot while paging and replaces stale totals when complete", () => {
    const files = [
      { name: "example.ts", hunks: [{ additionLines: 15, deletionLines: 1 }] } as FileDiffMetadata,
    ];
    const totals = { additions: 10, deletions: 20, changedFiles: 2 };
    expect(
      getPullRequestDiffStats({ files, omittedFileStats: new Map(), totals, complete: false }),
    ).toEqual(totals);
    expect(
      getPullRequestDiffStats({ files, omittedFileStats: new Map(), totals, complete: true }),
    ).toEqual({ additions: 15, deletions: 1, changedFiles: 1 });
  });
  it("counts a selected commit independently and includes withheld hunks", () => {
    const omittedFileStats = new Map([
      ["example.ts", { path: "example.ts", additions: 80, deletions: 40 }],
    ]);
    expect(
      getPullRequestDiffStats({ complete: false, files: [file], omittedFileStats, totals: null }),
    ).toEqual({
      additions: 80,
      deletions: 40,
      changedFiles: 1,
    });
    expect(
      getPullRequestDiffStats({
        complete: false,
        files: [file],
        omittedFileStats: new Map(),
        totals: null,
      }),
    ).toEqual({ additions: 3, deletions: 2, changedFiles: 1 });
  });
  it("includes omitted-only files without counting parsed paths twice", () => {
    const omittedFileStats = new Map([
      ["example.ts", { path: "example.ts", additions: 80, deletions: 40 }],
      ["omitted.ts", { path: "omitted.ts", additions: 10, deletions: 5 }],
    ]);
    for (const totals of [null, { additions: 200, deletions: 100, changedFiles: 3 }]) {
      expect(
        getPullRequestDiffStats({ files: [file], omittedFileStats, totals, complete: true }),
      ).toEqual({
        additions: 90,
        deletions: 45,
        changedFiles: 2,
      });
    }
    expect(
      getPullRequestDiffStats({ files: [], omittedFileStats, totals: null, complete: true }),
    ).toEqual({
      additions: 90,
      deletions: 45,
      changedFiles: 2,
    });
  });
});

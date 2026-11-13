import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  getFileViewedRange,
  isFileDiffCollapsed,
  isLineInFileDiff,
  keepUnchangedDiffPages,
  revalidateDiffPage,
  withFileDiffFold,
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

describe("isFileDiffCollapsed", () => {
  // regression: #9174 diffs now expand by default; a reader's fold must survive new slices
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const choices = new Map([["b.ts", true]]);
    expect(isFileDiffCollapsed("b.ts", "expanded", choices)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", "expanded", choices)).toBe(false);
  });

  it("folds a file marked Viewed when the Code tab mounts again with no fold choices", () => {
    expect(isFileDiffCollapsed("a.ts", "expanded", new Map(), true)).toBe(true);
    expect(isFileDiffCollapsed("a.ts", "expanded", new Map(), false)).toBe(false);
  });

  it("keeps a reader's choice when the file's Viewed mark loads later", () => {
    const choices = new Map([["a.ts", false]]);
    expect(isFileDiffCollapsed("a.ts", "expanded", choices, false)).toBe(false);
    expect(isFileDiffCollapsed("a.ts", "expanded", choices, true)).toBe(false);
  });
});

describe("withFileDiffFold", () => {
  it("records an absolute choice and keeps the same map when nothing changes", () => {
    const folded = withFileDiffFold(new Map(), "a.ts", true);
    expect(folded.get("a.ts")).toBe(true);
    expect(withFileDiffFold(folded, "a.ts", true)).toBe(folded);
    expect(withFileDiffFold(folded, "a.ts", false).get("a.ts")).toBe(false);
  });
});

describe("getFileViewedRange", () => {
  const files = ["c.ts", "a.ts", "b.ts", "d.ts"].map((fileKey) => ({ fileKey }));

  it("includes both endpoints in displayed order in either direction", () => {
    expect(getFileViewedRange(files, "b.ts", "c.ts")).toEqual(files.slice(0, 3));
    expect(getFileViewedRange(files, "c.ts", "b.ts")).toEqual(files.slice(0, 3));
    expect(getFileViewedRange(files, "a.ts", "a.ts")).toEqual([files[1]]);
  });

  it("changes only the clicked file without a current anchor", () => {
    expect(getFileViewedRange(files, "a.ts", null)).toEqual([files[1]]);
    expect(getFileViewedRange(files, "a.ts", "removed.ts")).toEqual([files[1]]);
    expect(getFileViewedRange(files, "removed.ts", "a.ts")).toEqual([]);
  });
});

describe("revalidateDiffPage", () => {
  const page = (cursor: string | null, patch: string, nextCursor: string | null) => ({
    cursor,
    patch,
    nextCursor,
    truncated: false,
    omittedFileStats: [],
  });
  const shown = [page(null, "one", "2"), page("2", "two", "3"), page("3", "three", "4")];

  it("re-reads every loaded page from fresh cursors before replacing any of them", () => {
    const first = revalidateDiffPage({ fresh: [], depth: 3 }, page(null, "one changed", "2b"));
    // The pages after the changed one stay on screen until all three are read again.
    if (!("revalidation" in first)) throw new Error("expected the refresh to continue");
    expect(first.cursor).toBe("2b");
    const second = revalidateDiffPage(first.revalidation, page("2b", "two", "3b"));
    if (!("revalidation" in second)) throw new Error("expected the refresh to continue");
    const third = revalidateDiffPage(second.revalidation, page("3b", "three", "4b"));
    expect(third).toEqual({
      pages: [page(null, "one changed", "2b"), page("2b", "two", "3b"), page("3b", "three", "4b")],
    });
  });

  it("ends where the refreshed diff does", () => {
    expect(revalidateDiffPage({ fresh: [], depth: 3 }, page(null, "all", null))).toEqual({
      pages: [page(null, "all", null)],
    });
  });

  it("keeps the identity of pages a refresh brought back unchanged", () => {
    const changed = page(null, "one changed", "2");
    const merged = keepUnchangedDiffPages(shown, [changed, { ...shown[1]! }, { ...shown[2]! }]);
    expect(merged[0]).toBe(changed);
    expect(merged[1]).toBe(shown[1]);
    expect(merged[2]).toBe(shown[2]);
    expect(
      keepUnchangedDiffPages(
        shown,
        shown.map((entry) => ({ ...entry })),
      ),
    ).toBe(shown);
  });
});

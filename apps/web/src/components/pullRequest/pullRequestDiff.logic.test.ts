import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { getFileViewedRange, isGitLfsPointerDiff, isLineInFileDiff } from "./pullRequestDiff.logic";

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

describe("isGitLfsPointerDiff", () => {
  const hunk = { deletionStart: 1, deletionCount: 0, additionStart: 1, additionCount: 3 };
  const file = (hunks: ReadonlyArray<typeof hunk>, additionLines: ReadonlyArray<string>) =>
    ({ name: "art/logo.png", hunks, additionLines }) as unknown as FileDiffMetadata;

  it("reads a patch of a Git LFS pointer as the pointer, not the file", () => {
    const pointer = [
      "version https://git-lfs.github.com/spec/v1\n",
      "oid sha256:5a8f16132efe3eb67a8dea335571beac2745147010dabcedde78dbe708e6bccd\n",
      "size 104158\n",
    ];
    expect(isGitLfsPointerDiff(file([hunk], pointer))).toBe(true);
    expect(
      isGitLfsPointerDiff(file([hunk], ["# version https://git-lfs.github.com/spec/v1\n"])),
    ).toBe(false);
    expect(isGitLfsPointerDiff(file([], []))).toBe(false);
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

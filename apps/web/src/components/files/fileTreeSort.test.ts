import { prepareFileTreeInput } from "@pierre/trees";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_FILE_TREE_SORT_ORDER,
  createFileTreeSortComparator,
  type FileTreeSortOrder,
  hasKeptEntryMtimeChanged,
} from "./fileTreeSort.ts";

const sortPaths = (
  paths: readonly string[],
  order: FileTreeSortOrder,
  mtimes: Readonly<Record<string, number>> = {},
  lookups: string[] = [],
) =>
  prepareFileTreeInput(paths, {
    sort: createFileTreeSortComparator(order, (path) => {
      lookups.push(path);
      return mtimes[path];
    }),
  }).paths;

const name = (direction: FileTreeSortOrder["direction"]): FileTreeSortOrder => ({
  key: "name",
  direction,
});
const modified = (direction: FileTreeSortOrder["direction"]): FileTreeSortOrder => ({
  key: "modified",
  direction,
});

describe("createFileTreeSortComparator", () => {
  it("reproduces the tree's default order for name ascending", () => {
    const paths = [
      "z.txt",
      "src/lib/util.ts",
      "src/Lib.ts",
      "src/lib/",
      "src/index.ts",
      ".github/workflows/ci.yml",
      ".env",
      "README.md",
      "readme.md",
      "Readme.md",
      "docs/",
      "Docs.md",
      "file10.txt",
      "file2.txt",
      "file02.txt",
      "_private.ts",
      "B.txt",
      "b.txt",
      "é.txt",
      "a/b/c/deep.txt",
      "a/z.txt",
      "a-b/x.txt",
    ];

    expect(sortPaths(paths, DEFAULT_FILE_TREE_SORT_ORDER)).toEqual(
      prepareFileTreeInput(paths).paths,
    );
  });

  it("reverses names within each group for name descending and keeps folders first", () => {
    const paths = ["b.txt", "a.txt", "c/x.txt", "a/y.txt", "c/a.txt"];

    expect(sortPaths(paths, name("desc"))).toEqual([
      "c/x.txt",
      "c/a.txt",
      "a/y.txt",
      "b.txt",
      "a.txt",
    ]);
  });

  it("sorts by modified time with folders first and name ascending for ties and missing times", () => {
    const paths = ["old.txt", "new.txt", "tie-b.txt", "tie-a.txt", "none-b.txt", "none-a.txt"];
    const mtimes = { "old.txt": 10, "new.txt": 30, "tie-a.txt": 20, "tie-b.txt": 20 };

    expect(sortPaths(paths, modified("desc"), mtimes)).toEqual([
      "new.txt",
      "tie-a.txt",
      "tie-b.txt",
      "old.txt",
      "none-a.txt",
      "none-b.txt",
    ]);
    expect(sortPaths(paths, modified("asc"), mtimes)).toEqual([
      "old.txt",
      "tie-a.txt",
      "tie-b.txt",
      "new.txt",
      "none-a.txt",
      "none-b.txt",
    ]);
  });

  it("keeps folders before files and orders them by their own mtime in modified mode", () => {
    const paths = ["file-new.txt", "dir-old/", "dir-new/", ".dot-dir/", ".dot-file"];
    const mtimes = {
      "file-new.txt": 99,
      "dir-old": 1,
      "dir-new": 50,
      ".dot-dir": 10,
      ".dot-file": 100,
    };

    expect(sortPaths(paths, modified("desc"), mtimes)).toEqual([
      "dir-new/",
      ".dot-dir/",
      "dir-old/",
      ".dot-file",
      "file-new.txt",
    ]);
  });

  it("looks up nested entries and ancestors by their path without a trailing slash", () => {
    const paths = ["a/old.txt", "a/new.txt", "b/inner/", "b/inner/x.txt", "b/file.txt"];
    const mtimes = {
      a: 1,
      b: 2,
      "a/old.txt": 5,
      "a/new.txt": 6,
      "b/inner": 7,
      "b/file.txt": 8,
    };
    const lookups: string[] = [];

    expect(sortPaths(paths, modified("desc"), mtimes, lookups)).toEqual([
      "b/inner/",
      "b/inner/x.txt",
      "b/file.txt",
      "a/new.txt",
      "a/old.txt",
    ]);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.filter((path) => path.endsWith("/"))).toEqual([]);
  });
});

describe("hasKeptEntryMtimeChanged", () => {
  const timestamps = (entries: Readonly<Record<string, number | undefined>>) => ({
    entryKinds: new Map(Object.keys(entries).map((path) => [path, "file"])),
    mtimes: new Map(
      Object.entries(entries).flatMap(([path, mtimeMs]) =>
        mtimeMs === undefined ? [] : [[path, mtimeMs] as const],
      ),
    ),
  });
  const before = timestamps({ "a.ts": 1, "b.ts": 2 });

  it("ignores added and removed paths", () => {
    expect(hasKeptEntryMtimeChanged(before, timestamps({ "a.ts": 1, "b.ts": 2, "c.ts": 3 }))).toBe(
      false,
    );
    expect(hasKeptEntryMtimeChanged(before, timestamps({ "a.ts": 1 }))).toBe(false);
  });

  it("detects a kept path whose time changes, appears or disappears", () => {
    expect(hasKeptEntryMtimeChanged(before, timestamps({ "a.ts": 5, "b.ts": 2 }))).toBe(true);
    expect(hasKeptEntryMtimeChanged(before, timestamps({ "a.ts": undefined, "b.ts": 2 }))).toBe(
      true,
    );
    expect(
      hasKeptEntryMtimeChanged(timestamps({ "a.ts": undefined }), timestamps({ "a.ts": 1 })),
    ).toBe(true);
  });
});

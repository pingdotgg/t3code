import { describe, expect, it } from "vite-plus/test";

import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";

describe("parseTurnDiffFilesFromNumstat", () => {
  it("sorts files and preserves addition and deletion counts", () => {
    const numstat = ["0\t2\tsrc/b.ts", "2\t1\ta.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/b.ts", kind: "modified", additions: 0, deletions: 2 },
    ]);
  });

  it("preserves both paths and the kind for renames and copies", () => {
    const numstat = [
      ":100644 100644 1111111 1111111 R100",
      "src/old.ts",
      "src/new.ts",
      ":100644 100644 2222222 3333333 C080",
      "src/source.ts",
      "src/copied.ts",
      ":000000 100644 0000000 4444444 A",
      "other.ts",
      "0\t0\t",
      "src/old.ts",
      "src/new.ts",
      "2\t1\t",
      "src/source.ts",
      "src/copied.ts",
      "1\t0\tother.ts",
      "",
    ].join("\0");

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "other.ts", kind: "added", additions: 1, deletions: 0 },
      {
        path: "src/copied.ts",
        previousPath: "src/source.ts",
        kind: "added",
        additions: 2,
        deletions: 1,
      },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        kind: "renamed",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("marks binary files and keeps empty files with zero line changes", () => {
    const numstat = ["-\t-\timage.png", "0\t0\tempty.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "empty.txt", kind: "modified", additions: 0, deletions: 0 },
      { path: "image.png", kind: "modified", additions: 0, deletions: 0, binary: true },
    ]);
  });

  it("preserves Unicode, tabs, line endings, and spaces in paths", () => {
    const path = " café\tline\r\nname.txt ";
    const raw = `:100644 100644 1111111 2222222 R090\0old\tname\n.txt\0${path}\0`;
    const numstat = `${raw}3\t2\t\0old\tname\n.txt\0${path}\0`;

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path, previousPath: "old\tname\n.txt", kind: "renamed", additions: 3, deletions: 2 },
    ]);
    expect(parseTurnDiffFilesFromNumstat(`1\t0\t${path}\0`)).toEqual([
      { path, kind: "modified", additions: 1, deletions: 0 },
    ]);
  });
});

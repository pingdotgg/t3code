import { describe, expect, it } from "vite-plus/test";

import { resolveCommitDialogSelection, resolveUnstagedFiles } from "./gitActions.ts";

describe("resolveUnstagedFiles", () => {
  const file = (path: string, staged?: "none" | "partial" | "all") => ({
    path,
    insertions: 1,
    deletions: 0,
    ...(staged ? { staged } : {}),
  });

  it("includes every file when nothing is staged", () => {
    expect(resolveUnstagedFiles([file("a.ts", "none"), file("b.ts", "none")])).toEqual(new Set());
  });

  it("excludes files with nothing staged once something is staged", () => {
    expect(
      resolveUnstagedFiles([
        file("staged.ts", "all"),
        file("partial.ts", "partial"),
        file("unstaged.ts", "none"),
      ]),
    ).toEqual(new Set(["unstaged.ts"]));
  });

  it("includes every file when the server does not report staged state", () => {
    expect(resolveUnstagedFiles([file("a.ts"), file("b.ts")])).toEqual(new Set());
  });
});

describe("resolveCommitDialogSelection", () => {
  const file = (path: string, staged: "none" | "partial" | "all") => ({
    path,
    insertions: 1,
    deletions: 0,
    staged,
  });

  it("commits the index when every file is at least partly staged", () => {
    const selection = resolveCommitDialogSelection({
      files: [file("a.ts", "all"), file("b.ts", "partial")],
      editedExclusions: null,
      includeUnstaged: false,
    });
    expect(selection.commitsStagedOnly).toBe(true);
    expect(selection.request).toEqual({});
  });

  it("commits everything when unstaged changes are included", () => {
    expect(
      resolveCommitDialogSelection({
        files: [file("a.ts", "all"), file("b.ts", "none")],
        editedExclusions: null,
        includeUnstaged: true,
      }).request,
    ).toEqual({ includeUnstaged: true });
  });

  it("commits the edited file list", () => {
    expect(
      resolveCommitDialogSelection({
        files: [file("a.ts", "all"), file("b.ts", "none")],
        editedExclusions: new Set(["a.ts"]),
        includeUnstaged: false,
      }).request,
    ).toEqual({ filePaths: ["b.ts"] });
  });
});

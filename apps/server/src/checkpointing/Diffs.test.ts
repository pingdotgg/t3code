import { describe, expect, it } from "vite-plus/test";

import { filterUnifiedDiffFiles, parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

describe("parseTurnDiffFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", () => {
    expect(parseTurnDiffFilesFromUnifiedDiff("")).toEqual([]);
  });

  it("parses per-file additions and deletions", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
    ]);
  });
});

describe("filterUnifiedDiffFiles", () => {
  const twoFileDiff = [
    "diff --git a/kept.ts b/kept.ts",
    "index 1111111..2222222 100644",
    "--- a/kept.ts",
    "+++ b/kept.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "diff --git a/dropped.ts b/dropped.ts",
    "index 3333333..4444444 100644",
    "--- a/dropped.ts",
    "+++ b/dropped.ts",
    "@@ -1,1 +1,1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");

  it("removes sections whose path is rejected", () => {
    const filtered = filterUnifiedDiffFiles(twoFileDiff, (path) => path !== "dropped.ts");
    expect(filtered).toContain("kept.ts");
    expect(filtered).not.toContain("dropped.ts");
    expect(parseTurnDiffFilesFromUnifiedDiff(filtered)).toEqual([
      { path: "kept.ts", additions: 1, deletions: 1 },
    ]);
  });

  it("returns the diff unchanged when everything is kept", () => {
    expect(filterUnifiedDiffFiles(twoFileDiff, () => true)).toBe(twoFileDiff);
  });

  it("filters deleted files via the --- a/ path", () => {
    const deletionDiff = [
      "diff --git a/removed.ts b/removed.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/removed.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    expect(filterUnifiedDiffFiles(deletionDiff, (path) => path !== "removed.ts").trim()).toBe("");
  });

  it("keeps unparseable sections", () => {
    const oddDiff = ["diff --git a/x b/x", "Binary files differ", ""].join("\n");
    expect(filterUnifiedDiffFiles(oddDiff, () => false)).toBe(oddDiff);
  });

  it("returns empty diff unchanged", () => {
    expect(filterUnifiedDiffFiles("", () => false)).toBe("");
  });
});

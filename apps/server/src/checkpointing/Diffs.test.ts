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

  it("filters simple header-only sections via the diff --git header", () => {
    const oddDiff = ["diff --git a/x b/x", "Binary files differ", ""].join("\n");
    expect(filterUnifiedDiffFiles(oddDiff, (path) => path !== "x").trim()).toBe("");
  });

  it("keeps unparseable sections", () => {
    const oddDiff = ["diff --git malformed-header", "Binary files differ", ""].join("\n");
    expect(filterUnifiedDiffFiles(oddDiff, () => false)).toBe(oddDiff);
  });

  it("returns empty diff unchanged", () => {
    expect(filterUnifiedDiffFiles("", () => false)).toBe("");
  });
});

describe("resolveDiffSectionPath via renames", () => {
  it("filters rename sections by the post-image path", () => {
    const renameDiff = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 90%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "index 1111111..2222222 100644",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "@@ -1,1 +1,1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    // The attribution map is keyed by post-image paths; a filter that only
    // knows the new path must still match this section.
    expect(filterUnifiedDiffFiles(renameDiff, (path) => path !== "new/name.ts").trim()).toBe("");
    expect(filterUnifiedDiffFiles(renameDiff, (path) => path !== "old/name.ts")).toBe(renameDiff);
  });
});

describe("filterUnifiedDiffFiles fallback paths", () => {
  it("filters binary sections via the diff --git header", () => {
    const binaryDiff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "",
    ].join("\n");
    expect(filterUnifiedDiffFiles(binaryDiff, (path) => path !== "assets/logo.png").trim()).toBe(
      "",
    );
    expect(filterUnifiedDiffFiles(binaryDiff, () => true)).toBe(binaryDiff);
  });

  it("filters mode-only sections via the diff --git header", () => {
    const modeDiff = [
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    expect(filterUnifiedDiffFiles(modeDiff, (path) => path !== "scripts/run.sh").trim()).toBe("");
  });

  it("filters binary sections with spaces in the path", () => {
    const binaryDiff = [
      "diff --git a/my assets/logo file.png b/my assets/logo file.png",
      "Binary files differ",
      "",
    ].join("\n");
    expect(
      filterUnifiedDiffFiles(binaryDiff, (path) => path !== "my assets/logo file.png").trim(),
    ).toBe("");
  });

  it("decodes git C-style quoted paths", () => {
    const quotedDiff = [
      'diff --git "a/sp\\303\\244ce.ts" "b/sp\\303\\244ce.ts"',
      "index 1111111..2222222 100644",
      '--- "a/sp\\303\\244ce.ts"',
      '+++ "b/sp\\303\\244ce.ts"',
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    // git octal-escapes UTF-8 bytes; our decoder maps each escaped byte to a
    // char code, so the filter key uses the same byte-per-char convention.
    const decodedPath = "spÃ¤ce.ts";
    expect(filterUnifiedDiffFiles(quotedDiff, (path) => path !== decodedPath).trim()).toBe("");
  });

  it("filters rename-only sections without hunks via rename metadata", () => {
    const renameOnlyDiff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    expect(filterUnifiedDiffFiles(renameOnlyDiff, (path) => path !== "new.ts").trim()).toBe("");
    expect(filterUnifiedDiffFiles(renameOnlyDiff, (path) => path !== "old.ts")).toBe(
      renameOnlyDiff,
    );
  });

  it("keeps ambiguous unquoted rename headers", () => {
    // Rename of a space-containing path is ambiguous in the header when git
    // does not quote; with no other metadata the section must be kept.
    const ambiguous = ["diff --git a/x y b/y z", "Binary files differ", ""].join("\n");
    expect(filterUnifiedDiffFiles(ambiguous, () => false)).toBe(ambiguous);
  });
});

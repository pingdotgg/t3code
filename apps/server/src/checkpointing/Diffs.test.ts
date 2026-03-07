import { describe, expect, it } from "vitest";

import { parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

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

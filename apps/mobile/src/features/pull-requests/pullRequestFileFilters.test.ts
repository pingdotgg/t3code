import { describe, expect, it } from "vite-plus/test";
import { buildNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { filterPullRequestTestFiles, isPullRequestTestFile } from "./pullRequestFileFilters";

function patch(path: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

describe("mobile PR test file filter", () => {
  it("recognizes test names, test directories and snapshots across common languages", () => {
    const paths = [
      "src/app.test.ts",
      "src/app.spec.tsx",
      "src/__tests__/app.ts",
      "tests/helpers/fixtures.json",
      "test/app.js",
      "e2e/login.ts",
      "src/__snapshots__/app.snap",
      "src/app.test.ts.snap",
      "test_app.py",
      "app_test.py",
      "internal/app_test.go",
      "app_test.cpp",
      "spec/app_spec.rb",
      "AppTests.swift",
      "AppTest.kt",
      "AppSpec.java",
      "AppTests.cs",
      "src\\__tests__\\app.ts",
    ];
    expect(paths.filter(isPullRequestTestFile)).toEqual(paths);
    expect(
      [
        "src/testing.ts",
        "src/contest.ts",
        "src/testUtils.ts",
        "latest/app.ts",
        "tests.ts",
        "specification.md",
        "AppTest.ts",
        "pnpm-lock.yaml",
      ].filter(isPullRequestTestFile),
    ).toEqual([]);
  });

  it("removes whole files from the native diff while retaining source order and line anchors", () => {
    const parsed = buildReviewParsedDiff(
      ["src/first.test.ts", "src/first.ts", "src/__tests__/second.ts", "src/second.ts"]
        .map(patch)
        .join("\n"),
      "pr",
    );
    const visible = filterPullRequestTestFiles(parsed, true);
    if (parsed.kind !== "files" || visible.kind !== "files") throw new Error("Expected files");
    expect(visible.files.map((file) => file.path)).toEqual(["src/first.ts", "src/second.ts"]);
    expect(visible.fileCount).toBe(2);
    expect(visible.additions).toBe(2);
    expect(visible.deletions).toBe(2);
    expect(visible.files[0]).toBe(parsed.files[1]);
    expect(visible.files[1]).toBe(parsed.files[3]);
    const allRows = buildNativeReviewDiffData(parsed).rows;
    const visibleData = buildNativeReviewDiffData(visible);
    const visibleIds = new Set(visible.files.map((file) => file.id));
    expect(visibleData.rows).toEqual(allRows.filter((row) => visibleIds.has(row.fileId ?? "")));
    expect(filterPullRequestTestFiles(parsed, false)).toBe(parsed);
    expect(parsed.files).toHaveLength(4);
  });

  it("uses the current path when a file is renamed out of a test directory", () => {
    const parsed = buildReviewParsedDiff(
      "diff --git a/tests/helper.ts b/src/helper.ts\nsimilarity index 100%\nrename from tests/helper.ts\nrename to src/helper.ts\n",
      "pr",
    );
    expect(filterPullRequestTestFiles(parsed, true)).toBe(parsed);
  });

  it("keeps an all-test result distinct from a missing diff and preserves truncation notices", () => {
    const parsed = buildReviewParsedDiff(patch("src/app.test.ts"), "pr");
    if (parsed.kind !== "files") throw new Error("Expected files");
    const visible = filterPullRequestTestFiles(
      { ...parsed, notice: "More files unavailable" },
      true,
    );
    expect(visible).toMatchObject({
      kind: "files",
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
      notice: "More files unavailable",
    });
    const raw = { kind: "raw" as const, text: "unparsed", reason: "Unsupported", notice: null };
    expect(filterPullRequestTestFiles(raw, true)).toBe(raw);
    const empty = { kind: "empty" as const };
    expect(filterPullRequestTestFiles(empty, true)).toBe(empty);
  });
});

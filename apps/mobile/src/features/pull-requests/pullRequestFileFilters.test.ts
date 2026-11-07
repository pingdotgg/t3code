import { describe, expect, it } from "vite-plus/test";
import { buildNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { filterPullRequestFiles } from "./pullRequestFileFilters";

function patch(path: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

describe("mobile PR file filter", () => {
  it("removes whole files from the native diff while retaining source order and line anchors", () => {
    const parsed = buildReviewParsedDiff(
      ["src/first.test.ts", "src/first.ts", "src/__tests__/second.ts", "src/second.ts"]
        .map(patch)
        .join("\n"),
      "pr",
    );
    const visible = filterPullRequestFiles(parsed, { hideTestFiles: true });
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
    expect(filterPullRequestFiles(parsed, { hideTestFiles: false })).toBe(parsed);
    expect(parsed.files).toHaveLength(4);
  });

  it("keeps a guide's target test file visible without exposing other hidden tests", () => {
    const parsed = buildReviewParsedDiff(
      ["src/first.test.ts", "src/app.ts", "src/second.test.ts"].map(patch).join("\n"),
      "pr",
    );
    const visible = filterPullRequestFiles(parsed, {
      hideTestFiles: true,
      includePath: "src/second.test.ts",
    });
    if (parsed.kind !== "files" || visible.kind !== "files") throw new Error("Expected files");
    expect(visible.files.map((file) => file.path)).toEqual(["src/app.ts", "src/second.test.ts"]);
    expect(visible.files[1]).toBe(parsed.files[2]);
  });

  it("uses the current path when a file is renamed out of a test directory", () => {
    const parsed = buildReviewParsedDiff(
      "diff --git a/tests/helper.ts b/src/helper.ts\nsimilarity index 100%\nrename from tests/helper.ts\nrename to src/helper.ts\n",
      "pr",
    );
    expect(filterPullRequestFiles(parsed, { hideTestFiles: true })).toBe(parsed);
  });

  it("keeps an all-test result distinct from a missing diff and preserves truncation notices", () => {
    const parsed = buildReviewParsedDiff(patch("src/app.test.ts"), "pr");
    if (parsed.kind !== "files") throw new Error("Expected files");
    const visible = filterPullRequestFiles(
      { ...parsed, notice: "More files unavailable" },
      { hideTestFiles: true },
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
    expect(filterPullRequestFiles(raw, { hideTestFiles: true })).toBe(raw);
    const empty = { kind: "empty" as const };
    expect(filterPullRequestFiles(empty, { hideTestFiles: true })).toBe(empty);
  });

  it("hides documentation files independently of tests", () => {
    const parsed = buildReviewParsedDiff(
      ["README.md", "src/app.ts", "src/app.test.ts", "docs/guide.mdx"].map(patch).join("\n"),
      "pr",
    );
    const withoutDocs = filterPullRequestFiles(parsed, { hideDocumentationFiles: true });
    if (parsed.kind !== "files" || withoutDocs.kind !== "files") {
      throw new Error("Expected files");
    }
    expect(withoutDocs.files.map((file) => file.path)).toEqual(["src/app.ts", "src/app.test.ts"]);
    const withoutBoth = filterPullRequestFiles(parsed, {
      hideTestFiles: true,
      hideDocumentationFiles: true,
    });
    if (withoutBoth.kind !== "files") throw new Error("Expected files");
    expect(withoutBoth.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    const withGuide = filterPullRequestFiles(parsed, {
      hideDocumentationFiles: true,
      includePath: "docs/guide.mdx",
    });
    if (withGuide.kind !== "files") throw new Error("Expected files");
    expect(withGuide.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "src/app.test.ts",
      "docs/guide.mdx",
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeReviewDiffData,
  getCachedNativeReviewDiffData,
} from "./nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { buildReviewParsedDiff } from "./reviewModel";

function makeComment(text: string): ReviewInlineComment {
  return {
    id: "comment-1",
    sectionId: "git:working-tree",
    sectionTitle: "Dirty worktree",
    filePath: "example.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "-1",
    text,
    diff: "@@ -1,1 +1,0 @@\n-const before = 1;",
  };
}

function filesPatch(paths: ReadonlyArray<string>) {
  return paths
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,2 +1,2 @@",
        '-const first = renderPanel({ label: "before", enabled: true });',
        '-const second = renderPanel({ label: "before", enabled: true });',
        '+const first = renderPanel({ label: "after", enabled: true });',
        '+const second = renderPanel({ label: "after", enabled: true });',
      ].join("\n"),
    )
    .join("\n");
}

describe("getCachedNativeReviewDiffData", () => {
  it("keeps cached IDs and targets local to each parsed section and file layout", () => {
    const original = filesPatch(["example.ts", "second.ts"]);
    const variants = [
      buildReviewParsedDiff(original, "first-section"),
      buildReviewParsedDiff(original, "second-section"),
      buildReviewParsedDiff(
        filesPatch(["inserted.ts", "example.ts", "second.ts"]),
        "first-section",
      ),
      buildReviewParsedDiff(filesPatch(["second.ts", "example.ts"]), "first-section"),
      buildReviewParsedDiff(filesPatch(["example.ts"]), "first-section"),
      buildReviewParsedDiff(
        original.replaceAll("@@ -1,2 +1,2 @@", "@@ -7,2 +12,2 @@"),
        "first-section",
      ),
    ];
    for (const diff of [...variants, variants[0]!]) {
      const input = { parsedDiff: diff, comments: [makeComment("Coordinates")] };
      expect(getCachedNativeReviewDiffData(input)).toEqual(buildNativeReviewDiffData(input));
    }
  });
});

describe("buildNativeReviewDiffData row bound", () => {
  function singleFilePatch(path: string, lineCount: number) {
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...Array.from({ length: lineCount }, (_, index) => `+const value${index} = ${index};`),
    ].join("\n");
  }

  it("caps each huge file excerpt while preserving full counts and ordinary files", () => {
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(
        [singleFilePatch("huge.ts", 200_000), singleFilePatch("ordinary.ts", 1_000)].join("\n"),
        "native-review-row-bound",
      ),
    );
    const hugeHeader = data.rows.find((row) => row.kind === "file" && row.filePath === "huge.ts");
    const ordinaryHeader = data.rows.find(
      (row) => row.kind === "file" && row.filePath === "ordinary.ts",
    );
    expect(hugeHeader).toMatchObject({ additions: 200_000, deletions: 0 });
    expect(ordinaryHeader).toMatchObject({ additions: 1_000, deletions: 0 });
    expect(data).toMatchObject({ additions: 201_000, deletions: 0 });
    const hugeRows = data.rows.filter((row) => row.fileId === hugeHeader?.fileId);
    expect(hugeRows.filter((row) => row.kind === "line" || row.kind === "hunk")).toHaveLength(
      2_000,
    );
    expect(hugeRows.at(-2)).toMatchObject({ kind: "line", newLineNumber: 1_999 });
    expect(hugeRows.at(-1)).toMatchObject({
      kind: "notice",
      text: "This diff is too large to show in full.",
    });
    const ordinaryRows = data.rows.filter((row) => row.fileId === ordinaryHeader?.fileId);
    expect(ordinaryRows.filter((row) => row.kind === "line")).toHaveLength(1_000);
    expect(ordinaryRows.at(-1)).toMatchObject({
      kind: "line",
      newLineNumber: 1_000,
      content: "const value999 = 999;",
    });
    expect(ordinaryRows.some((row) => row.kind === "notice")).toBe(false);
  });
});

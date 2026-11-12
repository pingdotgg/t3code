import { expect, it } from "vite-plus/test";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "./reviewModel";
import { selectReviewFileDiff } from "./reviewPaneSelection";

const comparison = buildNativeReviewDiffData(
  buildReviewParsedDiff(
    [
      "diff --git a/first.ts b/first.ts",
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1 +1 @@",
      "-old first",
      "+new first",
      "diff --git a/second.ts b/second.ts",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -1 +1,2 @@",
      "-old second",
      "+new second",
      "+extra second",
    ].join("\n"),
    "opened-file",
  ),
);

it("opens only the selected file's diff and comment targets", () => {
  const selected = selectReviewFileDiff(comparison, "second.ts");
  expect(selected.files.map((file) => file.path)).toEqual(["second.ts"]);
  expect(selected.rows.length).toBeGreaterThan(0);
  expect(selected.rows.every((row) => row.fileId === selected.files[0]?.id)).toBe(true);
  expect(selected.additions).toBe(2);
  expect(selected.deletions).toBe(1);
  const ids = new Set(selected.rows.map((row) => row.id));
  expect(selected.commentTargetsByRowId.size).toBeGreaterThan(0);
  for (const [id, target] of selected.commentTargetsByRowId) {
    expect(ids.has(id)).toBe(true);
    expect(target.filePath).toBe("second.ts");
  }
  for (const id of selected.rowIdByCommentLineId.values()) expect(ids.has(id)).toBe(true);
  expect(comparison.files).toHaveLength(2);
});

it("does not fall back to another file when a selected file loses its changes", () => {
  const selected = selectReviewFileDiff(comparison, "removed.ts");
  expect(selected.files).toEqual([]);
  expect(selected.rows).toEqual([]);
  expect(selected.commentTargetsByRowId.size).toBe(0);
  expect(selected.rowIdByCommentLineId.size).toBe(0);
  expect(selected.additions).toBe(0);
  expect(selected.deletions).toBe(0);
});

import { expect, it } from "vite-plus/test";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { markdownSourceRevision, staleMarkdownNotes } from "./markdownReviewMapping";
it("keeps the original excerpt and marks moved or edited rendered annotations outdated", () => {
  const contents = "# Title\n\nText to review\n";
  const note = {
    ...buildFileReviewComment({
      id: "note",
      filePath: "README.md",
      startLine: 3,
      endLine: 3,
      text: "Clarify this",
      contents,
    }),
    sourceRevision: markdownSourceRevision(contents),
  };
  expect(staleMarkdownNotes([note], "README.md", contents)).toEqual([]);
  const stale = staleMarkdownNotes([note], "README.md", "Inserted line\n" + contents)[0]!;
  expect(stale.sourceStale).toBe(true);
  expect(stale.diff).toBe("Text to review");
  expect(stale.rangeLabel).toContain("Outdated");
  expect(staleMarkdownNotes([stale], "README.md", "Other edit")).toEqual([]);
});

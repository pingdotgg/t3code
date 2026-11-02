import { describe, expect, it } from "vite-plus/test";
import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { projectReviewDiffContext, reviewDiffEdits } from "./reviewDiffContext.ts";

const contents = (lines: ReadonlyArray<string>) => ({ name: "file.txt", contents: lines.join("") });

describe("review diff context projection", () => {
  it("compares trimmed partial-patch lines with hydrated lines while preserving real missing newlines", () => {
    const header = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n";
    const partial = parsePatchFiles(header + "@@ -1 +1 @@\n-old\n+new")[0]!.files[0]!;
    const full = parseDiffFromFile(contents(["old\n"]), contents(["new\n"]));
    expect(reviewDiffEdits(partial)).toBe(reviewDiffEdits(full));
    const missingNewline = parsePatchFiles(
      header + "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n",
    )[0]!.files[0]!;
    const fullMissingNewline = parseDiffFromFile(contents(["old\n"]), contents(["new"]));
    expect(reviewDiffEdits(missingNewline)).toBe(reviewDiffEdits(fullMissingNewline));
    expect(reviewDiffEdits(missingNewline)).not.toBe(reviewDiffEdits(full));
  });

  it("preserves full-document expansion coordinates after a nearby change is consumed", () => {
    const original = Array.from({ length: 150 }, (_, index) => `line ${index + 1}\n`);
    const working = [...original];
    working[82] = "changed near\n";
    working[84] = "changed nearby\n";
    working[123] = "changed far\n";
    const previous = parseDiffFromFile(contents(original), contents(working), { context: 3 });
    const index = [...original];
    index[82] = working[82]!;
    const next = projectReviewDiffContext(index, working, previous, "additions");

    expect(next.isPartial).toBe(false);
    expect(next.hunks.map((hunk) => [hunk.additionStart, hunk.additionCount])).toEqual(
      previous.hunks.map((hunk) => [hunk.additionStart, hunk.additionCount]),
    );
    // The viewer's indices still include all expandable unchanged lines before/between hunks.
    // The consumed deletion is the sole removed row; full context must not become compact.
    expect(next.splitLineCount).toBe(previous.splitLineCount);
    expect(next.unifiedLineCount).toBe(previous.unifiedLineCount - 1);
    expect(next.hunks[0]!.splitLineStart).toBe(previous.hunks[0]!.splitLineStart);
    expect(next.hunks[1]!.splitLineStart).toBe(previous.hunks[1]!.splitLineStart);
    expect(next.additionLines.slice(79, 87)).toEqual(working.slice(79, 87));
    expect(next.deletionLines[82]).toBe("changed near\n");
    expect(next.deletionLines[84]).toBe("line 85\n");
    const refreshed = parseDiffFromFile(contents(index), contents(working), { context: 3 });
    expect(reviewDiffEdits(next)).toBe(reviewDiffEdits(refreshed));
  });

  it("keeps expanded file contents and windows when the final change becomes context", () => {
    const old = Array.from({ length: 150 }, (_, index) => `line ${index + 1}\n`);
    const working = [...old];
    working[82] = "changed near\n";
    working[123] = "changed far\n";
    const previous = parseDiffFromFile(contents(old), contents(working), { context: 3 });
    const next = projectReviewDiffContext(working, working, previous, "additions");
    expect(reviewDiffEdits(next)).toBe("[]");
    expect(next.isPartial).toBe(false);
    expect(next.additionLines).toEqual(working);
    expect(next.deletionLines).toEqual(working);
    expect(next.splitLineCount).toBe(150);
    expect(next.unifiedLineCount).toBe(150);
    expect(next.hunks.map((hunk) => [hunk.additionStart, hunk.additionCount])).toEqual(
      previous.hunks.map((hunk) => [hunk.additionStart, hunk.additionCount]),
    );
    expect(next.hunks[1]!.splitLineStart).toBe(previous.hunks[1]!.splitLineStart);
  });
});

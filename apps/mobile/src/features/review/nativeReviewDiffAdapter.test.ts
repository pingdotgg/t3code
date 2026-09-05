import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  MOBILE_THEME_IDS,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "../../lib/mobileTheme";
import { readDefaultMobileThemeVariables } from "../../lib/mobileTheme.test-support";

import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  getCachedNativeReviewDiffData,
  type BuildNativeReviewDiffDataInput,
} from "./nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { buildReviewParsedDiff } from "./reviewModel";
import * as ReviewWordDiffs from "./reviewWordDiffs";
import { computeVisibleNativeReviewWordDiffRanges } from "./nativeReviewWordDiffs";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";

const parsedDiff = buildReviewParsedDiff(
  [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-const before = 1;",
    "+const after = 2;",
  ].join("\n"),
  "native-review-cache-test",
);

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

function buildInput(comments: BuildNativeReviewDiffDataInput["comments"]) {
  return { parsedDiff, comments } satisfies BuildNativeReviewDiffDataInput;
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

function appTheme(themeId: MobileThemeId, appearance: MobileThemeAppearance) {
  return themeId === DEFAULT_MOBILE_THEME_ID
    ? readDefaultMobileThemeVariables(appearance)
    : getMobileThemeVariables(themeId, appearance);
}

describe("getCachedNativeReviewDiffData", () => {
  it("reuses the row model for equivalent empty comment arrays", () => {
    const first = getCachedNativeReviewDiffData(buildInput([]));
    const second = getCachedNativeReviewDiffData(buildInput([]));

    expect(second).toBe(first);
  });

  it("reuses equivalent comment contents and invalidates changed comments", () => {
    const first = getCachedNativeReviewDiffData(buildInput([makeComment("First")]));
    const equivalent = getCachedNativeReviewDiffData(buildInput([makeComment("First")]));
    const changed = getCachedNativeReviewDiffData(buildInput([makeComment("Changed")]));

    expect(equivalent).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.rows.find((row) => row.kind === "comment")?.commentText).toBe("Changed");
  });

  it("defers word matching and reuses its results when a file comment changes", async () => {
    const diff = buildReviewParsedDiff(filesPatch(["example.ts", "second.ts"]), "comment-reuse");
    const matchWords = vi.spyOn(ReviewWordDiffs, "computeWordAltDiffRanges");
    try {
      const base = getCachedNativeReviewDiffData({ parsedDiff: diff });
      expect(matchWords).not.toHaveBeenCalled();
      expect(base.rows.filter((row) => row.wordDiffRanges?.length)).toHaveLength(0);
      const initialRanges = await computeVisibleNativeReviewWordDiffRanges({
        rows: base.rows,
        firstRowIndex: 0,
        lastRowIndex: base.rows.length - 1,
      });
      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(
        Object.values(initialRanges.rangesByRowId).filter((ranges) => ranges.length),
      ).toHaveLength(8);
      const firstComment = makeComment("First file comment");
      const secondComment = {
        ...makeComment("Second file comment"),
        id: "comment-2",
        filePath: "second.ts",
      };
      const first = getCachedNativeReviewDiffData({
        parsedDiff: diff,
        comments: [firstComment, secondComment],
      });
      const changed = getCachedNativeReviewDiffData({
        parsedDiff: diff,
        comments: [{ ...firstComment, text: "Changed first comment" }, secondComment],
      });

      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(changed.files).toBe(base.files);
      expect(changed.commentTargetsByRowId).toBe(base.commentTargetsByRowId);
      expect(changed.rowIdByCommentLineId).toBe(base.rowIdByCommentLineId);
      expect(changed.rows.find((row) => row.id === secondComment.id)).toBe(
        first.rows.find((row) => row.id === secondComment.id),
      );
      const sourceRows = changed.rows.filter((row) => row.kind !== "comment");
      for (const [index, row] of sourceRows.entries()) {
        expect(row).toBe(base.rows[index]);
      }
      const removed = getCachedNativeReviewDiffData({ parsedDiff: diff, comments: [] });
      expect(removed.rows).toEqual(base.rows);
      const changedRanges = await computeVisibleNativeReviewWordDiffRanges({
        rows: changed.rows,
        firstRowIndex: 0,
        lastRowIndex: changed.rows.length - 1,
      });
      expect(changedRanges).toEqual(initialRanges);
      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(first.rows.find((row) => row.id === firstComment.id)?.commentText).toBe(
        "First file comment",
      );
    } finally {
      matchWords.mockRestore();
    }
  });

  it("updates comment titles and locations without changing source coordinates", () => {
    const diff = buildReviewParsedDiff(filesPatch(["example.ts", "second.ts"]), "comment-metadata");
    const comment = makeComment("Review this line");
    const first = getCachedNativeReviewDiffData({ parsedDiff: diff, comments: [comment] });
    const renamed = getCachedNativeReviewDiffData({
      parsedDiff: diff,
      comments: [{ ...comment, sectionTitle: "Branch comparison" }],
    });
    expect(renamed.rows.find((row) => row.id === comment.id)?.commentSectionTitle).toBe(
      "Branch comparison",
    );
    const moved = getCachedNativeReviewDiffData({
      parsedDiff: diff,
      comments: [{ ...comment, filePath: "second.ts", endIndex: 99, rangeLabel: "+2" }],
    });
    const commentIndex = moved.rows.findIndex((row) => row.id === comment.id);
    expect(moved.rows[commentIndex]).toMatchObject({
      kind: "comment",
      filePath: "second.ts",
      commentRangeLabel: "+2",
    });
    expect(moved.rows[commentIndex - 1]).toMatchObject({
      kind: "line",
      change: "add",
      newLineNumber: 2,
    });
    expect(moved.rows.filter((row) => row.kind !== "comment")).toEqual(
      first.rows.filter((row) => row.kind !== "comment"),
    );
    expect(first.rows.find((row) => row.id === comment.id)?.commentSectionTitle).toBe(
      "Dirty worktree",
    );
  });

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

describe("visible native word diffs", () => {
  it("matches an offscreen counterpart without preparing unrelated pairs", async () => {
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(filesPatch(["example.ts"]), "visible-pair"),
    );
    const result = await computeVisibleNativeReviewWordDiffRanges({
      rows: data.rows,
      firstRowIndex: 2,
      lastRowIndex: 2,
      overscanRows: 0,
    });
    expect(result.pairCount).toBe(1);
    expect(Object.keys(result.rangesByRowId)).toEqual([data.rows[2]!.id, data.rows[4]!.id]);
    expect(result.rangesByRowId[data.rows[4]!.id]?.length).toBeGreaterThan(0);
    expect(
      await computeVisibleNativeReviewWordDiffRanges({
        rows: data.rows,
        firstRowIndex: 4,
        lastRowIndex: 4,
        overscanRows: 0,
        alreadyHighlightedRowIds: new Set(Object.keys(result.rangesByRowId)),
      }),
    ).toEqual({ rangesByRowId: {}, pairCount: 0 });
  });

  it("does not spend the visible pair budget on collapsed files", async () => {
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(filesPatch(["first.ts", "second.ts"]), "collapsed-pairs"),
    );
    const collapsedFileIds = new Set([data.files[0]!.id]);
    const result = await computeVisibleNativeReviewWordDiffRanges({
      rows: data.rows,
      firstRowIndex: 0,
      lastRowIndex: data.rows.length - 1,
      collapsedFileIds,
      overscanRows: 0,
      maxPairs: 1,
    });
    expect(result.pairCount).toBe(1);
    expect(Object.keys(result.rangesByRowId)).toEqual([data.rows[8]!.id, data.rows[10]!.id]);
    collapsedFileIds.clear();
    const reopened = await computeVisibleNativeReviewWordDiffRanges({
      rows: data.rows,
      firstRowIndex: 0,
      lastRowIndex: data.rows.length - 1,
      collapsedFileIds,
      overscanRows: 0,
      maxPairs: 1,
    });
    expect(Object.keys(reopened.rangesByRowId)).toEqual([data.rows[2]!.id, data.rows[4]!.id]);
  });

  it("yields and cancels while indexing rows without replacement pairs", async () => {
    const rows: NativeReviewDiffRow[] = Array.from({ length: 2_000 }, (_, index) => ({
      kind: "line",
      id: `context-${index}`,
      fileId: "context",
      change: "context",
      content: "unchanged",
    }));
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (elapsed += 5));
    const controller = new AbortController();
    try {
      const pending = computeVisibleNativeReviewWordDiffRanges({
        rows,
        firstRowIndex: 0,
        lastRowIndex: rows.length - 1,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 0);
      expect(await pending).toEqual({ rangesByRowId: {}, pairCount: 0 });
      expect(controller.signal.aborted).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("discards partial results when cancelled between batches and reuses completed pairs", async () => {
    const rows: NativeReviewDiffRow[] = (["delete", "add"] as const).flatMap((change) =>
      Array.from({ length: 65 }, (_, index) => ({
        kind: "line" as const,
        id: `${change}-${index}`,
        fileId: "file",
        change,
        content: `const row${index} = renderPanel({ label: "${change === "delete" ? "before" : "after"}", enabled: true });`,
      })),
    );
    const controller = new AbortController();
    const matchWords = vi.spyOn(ReviewWordDiffs, "computeWordAltDiffRanges");
    try {
      const pending = computeVisibleNativeReviewWordDiffRanges({
        rows,
        firstRowIndex: 0,
        lastRowIndex: rows.length - 1,
        signal: controller.signal,
      });
      // Cancellation runs on the next event-loop turn, so word matching must yield to it.
      setTimeout(() => controller.abort(), 0);
      expect(await pending).toEqual({ rangesByRowId: {}, pairCount: 0 });
      expect(matchWords.mock.calls.length).toBeGreaterThan(0);
      expect(matchWords.mock.calls.length).toBeLessThan(65);
      const resumed = await computeVisibleNativeReviewWordDiffRanges({
        rows,
        firstRowIndex: 0,
        lastRowIndex: rows.length - 1,
      });
      expect(resumed.pairCount).toBe(65);
      expect(Object.keys(resumed.rangesByRowId)).toHaveLength(130);
      expect(matchWords).toHaveBeenCalledTimes(65);
    } finally {
      matchWords.mockRestore();
    }
  });

  it("invalidates a cached pair when its same-ID counterpart changes", async () => {
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(filesPatch(["example.ts"]), "changed-pair"),
    );
    const first = await computeVisibleNativeReviewWordDiffRanges({
      rows: data.rows,
      firstRowIndex: 2,
      lastRowIndex: 2,
      overscanRows: 0,
    });
    const changedRow = {
      ...data.rows[4]!,
      content: data.rows[4]!.content!.replace("after", "updated-value"),
    };
    const changed = await computeVisibleNativeReviewWordDiffRanges({
      rows: data.rows.map((row) => (row.id === changedRow.id ? changedRow : row)),
      firstRowIndex: 2,
      lastRowIndex: 2,
      overscanRows: 0,
    });
    expect(changed.pairCount).toBe(1);
    expect(changed.rangesByRowId[changedRow.id]).not.toEqual(first.rangesByRowId[changedRow.id]);
  });
});

describe("createNativeReviewDiffTheme", () => {
  it("serializes every native color as cross-platform opaque hex", () => {
    for (const themeId of MOBILE_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const theme = createNativeReviewDiffTheme(
          appearance,
          themeId,
          appTheme(themeId, appearance),
        );
        for (const color of Object.values(theme)) {
          expect(color, `${themeId}/${appearance}`).toMatch(/^#[\da-f]{6}$/i);
        }
      }
    }
  });

  it("uses the selected app palette for native code surfaces", () => {
    const standard = createNativeReviewDiffTheme("dark", "t3-code", appTheme("t3-code", "dark"));
    const iris = createNativeReviewDiffTheme("dark", "iris", appTheme("iris", "dark"));

    expect(iris.background).not.toBe(standard.background);
    expect(iris.hunkText).not.toBe(standard.hunkText);
    expect(iris.addBar).toBe(standard.addBar);
    expect(iris.deleteBar).toBe(standard.deleteBar);
  });
});

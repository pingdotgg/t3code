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

  it("reuses source rows and word matching when a file comment changes", () => {
    const diff = buildReviewParsedDiff(filesPatch(["example.ts", "second.ts"]), "comment-reuse");
    const matchWords = vi.spyOn(ReviewWordDiffs, "computeWordAltDiffRanges");
    try {
      const base = getCachedNativeReviewDiffData({ parsedDiff: diff });
      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(base.rows.filter((row) => row.wordDiffRanges?.length)).toHaveLength(8);
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

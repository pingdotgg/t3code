import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";

import {
  createNativeReviewDiffTheme,
  getCachedNativeReviewDiffData,
  type BuildNativeReviewDiffDataInput,
} from "./nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { buildReviewParsedDiff } from "./reviewModel";

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
  });
});

describe("createNativeReviewDiffTheme", () => {
  it("serializes every native color as cross-platform opaque hex", () => {
    for (const themeId of MOBILE_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const theme = createNativeReviewDiffTheme(appearance, themeId);
        for (const color of Object.values(theme)) {
          expect(color, `${themeId}/${appearance}`).toMatch(/^#[\da-f]{6}$/i);
        }
      }
    }
  });

  it("uses the selected app palette for native code surfaces", () => {
    const standard = createNativeReviewDiffTheme("dark", "t3-code");
    const iris = createNativeReviewDiffTheme("dark", "iris");

    expect(iris.background).not.toBe(standard.background);
    expect(iris.hunkText).not.toBe(standard.hunkText);
    expect(iris.addBar).toBe(standard.addBar);
    expect(iris.deleteBar).toBe(standard.deleteBar);
  });
});

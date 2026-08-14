import { describe, expect, it } from "vite-plus/test";

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

describe("createNativeReviewDiffTheme", () => {
  it("keeps the default light review output byte-for-byte stable", () => {
    expect(createNativeReviewDiffTheme("light")).toEqual({
      background: "#f2f2f7",
      text: "#070707",
      mutedText: "#8E8E95",
      headerBackground: "#f2f2f7",
      border: "#eeeeef",
      hunkBackground: "#e0f2ff",
      hunkText: "#009fff",
      addBackground: "#e5f8f5",
      deleteBackground: "#ffe6e7",
      addBar: "#00cab1",
      deleteBar: "#ff2e3f",
      addText: "#199F43",
      deleteText: "#D52C36",
    });
  });

  it("keeps the default dark review output byte-for-byte stable", () => {
    expect(createNativeReviewDiffTheme("dark")).toEqual({
      background: "#0e0e0e",
      text: "#adadb1",
      mutedText: "#8E8E95",
      headerBackground: "#0e0e0e",
      border: "#2e2e30",
      hunkBackground: "#071f28",
      hunkText: "#009fff",
      addBackground: "#0d2f28",
      deleteBackground: "#391415",
      addBar: "#00cab1",
      deleteBar: "#ff2e3f",
      addText: "#5ECC71",
      deleteText: "#FF6762",
    });
  });

  it("themes surface roles without changing diff semantic colors", () => {
    const base = createNativeReviewDiffTheme("dark");
    const themed = createNativeReviewDiffTheme("dark", {
      sheetBackground: "#101820",
      foreground: "#f0f4f8",
      mutedForeground: "#8795a1",
      border: "#334455",
      accent: "#44aaff",
    });

    expect(themed).toMatchObject({
      background: "#101820",
      text: "#f0f4f8",
      mutedText: "#8795a1",
      headerBackground: "#101820",
      border: "#334455",
      hunkText: "#44aaff",
    });
    expect(themed).toMatchObject({
      addBackground: base.addBackground,
      deleteBackground: base.deleteBackground,
      addBar: base.addBar,
      deleteBar: base.deleteBar,
      addText: base.addText,
      deleteText: base.deleteText,
    });
  });

  it("serializes native review alpha colors in CSS RRGGBBAA order", () => {
    const payload = JSON.stringify(
      createNativeReviewDiffTheme("dark", {
        sheetBackground: "#11223344",
        foreground: "#55667788",
        mutedForeground: "#99aabbcc",
        border: "#ddeeff11",
        accent: "#22446680",
      }),
    );

    expect(payload).toContain('"background":"#11223344"');
    expect(payload).toContain('"text":"#55667788"');
    expect(payload).toContain('"mutedText":"#99aabbcc"');
    expect(payload).toContain('"border":"#ddeeff11"');
    expect(payload).toContain('"hunkText":"#22446680"');
  });
});

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

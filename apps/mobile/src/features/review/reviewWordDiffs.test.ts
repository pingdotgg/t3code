import { describe, expect, it } from "vite-plus/test";

import { applyDiffRangesToTokens, computeWordAltDiffRanges } from "./reviewWordDiffs";

describe("computeWordAltDiffRanges", () => {
  it("joins adjacent word replacements across a single shared separator", () => {
    const ranges = computeWordAltDiffRanges({
      deletionLine: "old old",
      additionLine: "new new",
    });

    expect(ranges.deletion).toEqual([{ start: 0, end: "old old".length }]);
    expect(ranges.addition).toEqual([{ start: 0, end: "new new".length }]);
  });

  it("skips inline word diffs for long lines", () => {
    const longDeletion = `const before = "${"a".repeat(1_001)}";`;
    const longAddition = `const after = "${"b".repeat(1_001)}";`;

    const ranges = computeWordAltDiffRanges({
      deletionLine: longDeletion,
      additionLine: longAddition,
    });

    expect(ranges.deletion).toEqual([]);
    expect(ranges.addition).toEqual([]);
  });
});

describe("applyDiffRangesToTokens", () => {
  it("splits highlighted fragments out of syntax tokens", () => {
    const tokens = [
      {
        content: "const before = 1;",
        color: "#fff",
        fontStyle: null,
      },
    ];
    const nextTokens = applyDiffRangesToTokens(tokens, [{ start: 6, end: 12 }]);

    expect(nextTokens).toEqual([
      {
        content: "const ",
        color: "#fff",
        fontStyle: null,
        diffHighlight: false,
      },
      {
        content: "before",
        color: "#fff",
        fontStyle: null,
        diffHighlight: true,
      },
      {
        content: " = 1;",
        color: "#fff",
        fontStyle: null,
        diffHighlight: false,
      },
    ]);
  });

  it("skips exhausted ranges when later tokens start after the last range", () => {
    const tokens = [
      {
        content: "a",
        color: "#fff",
        fontStyle: null,
      },
      {
        content: "b",
        color: "#fff",
        fontStyle: null,
      },
    ];

    const nextTokens = applyDiffRangesToTokens(tokens, [{ start: 0, end: 1 }]);

    expect(nextTokens).toEqual([
      {
        content: "a",
        color: "#fff",
        fontStyle: null,
        diffHighlight: true,
      },
      {
        content: "b",
        color: "#fff",
        fontStyle: null,
      },
    ]);
  });
});

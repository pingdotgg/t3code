import { describe, expect, it } from "vite-plus/test";

import { buildNativeReviewTokensResetKey, hashReviewDiffKey } from "./reviewDiffBridgeKeys";

describe("native review diff bridge", () => {
  it("builds stable reset keys from the rendered diff identity", () => {
    const input = {
      threadKey: "env:thread",
      sectionId: "turn:2",
      scheme: "dark" as const,
      diff: "diff --git a/a.ts b/a.ts",
      fileCount: 1,
      rowCount: 4,
    };

    expect(buildNativeReviewTokensResetKey(input)).toBe(buildNativeReviewTokensResetKey(input));
    expect(buildNativeReviewTokensResetKey({ ...input, rowCount: 5 })).not.toBe(
      buildNativeReviewTokensResetKey(input),
    );
    expect(buildNativeReviewTokensResetKey({ ...input, diff: null })).toContain(":empty:");
  });

  it("includes diff length in the hash key to reduce accidental collisions", () => {
    expect(hashReviewDiffKey("abc")).toMatch(/^3:/);
    expect(hashReviewDiffKey("abcd")).toMatch(/^4:/);
  });
});

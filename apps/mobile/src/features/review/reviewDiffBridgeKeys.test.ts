import { describe, expect, it } from "vite-plus/test";

import { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";

describe("native review diff bridge", () => {
  it("changes reset keys when the rendered diff identity changes", () => {
    const input = {
      threadKey: "env:thread",
      sectionId: "turn:2",
      scheme: "dark" as const,
      diff: "diff --git a/a.ts b/a.ts",
      fileCount: 1,
      rowCount: 4,
    };

    const resetKey = buildNativeReviewTokensResetKey(input);

    expect(
      buildNativeReviewTokensResetKey({ ...input, diff: "diff --git a/b.ts b/b.ts" }),
    ).not.toBe(resetKey);
    expect(buildNativeReviewTokensResetKey({ ...input, rowCount: 5 })).not.toBe(resetKey);
    expect(buildNativeReviewTokensResetKey({ ...input, diff: null })).not.toBe(resetKey);
  });
});

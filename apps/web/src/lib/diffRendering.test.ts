import { describe, expect, it } from "vite-plus/test";
import {
  buildPatchCacheKey,
  canRenderFileDiff,
  MAX_RENDERABLE_DIFF_LINE_LENGTH,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("diff render line limits", () => {
  it("rejects file diffs with pathological line lengths", () => {
    expect(
      canRenderFileDiff({
        additionLines: ["small"],
        deletionLines: ["x".repeat(MAX_RENDERABLE_DIFF_LINE_LENGTH + 1)],
      }),
    ).toBe(false);
  });

  it("allows file diffs within the line length limit", () => {
    expect(
      canRenderFileDiff({
        additionLines: ["x".repeat(MAX_RENDERABLE_DIFF_LINE_LENGTH)],
        deletionLines: ["small"],
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getDiffLineStat,
  getRenderablePatch,
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

describe("getRenderablePatch", () => {
  it("keeps file identities stable while changing only affected file cache keys", () => {
    const before = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-before a",
      "+after a",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-before b",
      "+after b",
    ].join("\n");
    const after = [
      "diff --git a/aa.ts b/aa.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/aa.ts",
      "@@ -0,0 +1 @@",
      "+new file",
      before.replace("+after a", "+after a again"),
    ].join("\n");

    const parsedBefore = getRenderablePatch(before, "live-diff");
    const parsedAfter = getRenderablePatch(after, "live-diff");
    expect(parsedBefore?.kind).toBe("files");
    expect(parsedAfter?.kind).toBe("files");
    if (parsedBefore?.kind !== "files" || parsedAfter?.kind !== "files") return;

    expect(buildFileDiffRenderKey(parsedBefore.files[0]!)).toBe(
      buildFileDiffRenderKey(parsedAfter.files[1]!),
    );
    expect(parsedBefore.files[0]?.cacheKey).not.toBe(parsedAfter.files[1]?.cacheKey);
    expect(parsedBefore.files[1]?.cacheKey).toBe(parsedAfter.files[2]?.cacheKey);
  });

  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const parsed = getRenderablePatch(patch);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    expect(getDiffLineStat(parsed.files)).toEqual({ additions: 3, deletions: 2 });
  });
});

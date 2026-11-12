import { DiffHunksRenderer, hydratePartialDiff, type FileDiffMetadata } from "@pierre/diffs";
import { excerptRows, fileDiffRows, rowsToPatch } from "@t3tools/client-runtime/review-guide-tour";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import { getRenderablePatch } from "~/lib/diffRendering";
import { excerptLoader } from "./GuideExcerpt.logic";

function parse(patch: string): FileDiffMetadata {
  const renderable = getRenderablePatch(patch, "guide-excerpt-test");
  if (renderable?.kind !== "files") throw new Error("Expected a parsed patch.");
  return renderable.files[0]!;
}

it("expands an excerpt whose file has another hunk that changes its length", async () => {
  const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
  const changed = original.map((line, index) => (index === 29 ? "line 30 changed" : line));
  changed.splice(80, 0, "later insertion");
  const file = parse(
    [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -27,7 +27,7 @@",
      " line 27",
      " line 28",
      " line 29",
      "-line 30",
      "+line 30 changed",
      " line 31",
      " line 32",
      " line 33",
      "@@ -78,6 +78,7 @@",
      " line 78",
      " line 79",
      " line 80",
      "+later insertion",
      " line 81",
      " line 82",
      " line 83",
      "",
    ].join("\n"),
  );
  const excerpt = { path: "file.ts", side: "new", start: 30, end: 30, caption: "" } as const;
  const rows = excerptRows(fileDiffRows(file), excerpt);
  const excerptDiff = parse(rowsToPatch("file.ts", "file.ts", rows));
  const loadDiffFiles = createGitDiffFileContentsLoader(
    async () =>
      AsyncResult.success({
        oldContents: `${original.join("\n")}\n`,
        newContents: `${changed.join("\n")}\n`,
      }),
    {
      environmentId: EnvironmentId.make("environment-guide-excerpt-test"),
      cwd: "/repo",
      sourceKind: "working-tree",
      baseRef: null,
      headRef: null,
      cacheKey: "diff-hash",
    },
  );

  const files = await excerptLoader(excerpt, file, rows, loadDiffFiles)!(excerptDiff);
  const hydrated = hydratePartialDiff("clone", excerptDiff, files);

  await expect(
    new DiffHunksRenderer({ expandUnchanged: true }).asyncRender(hydrated),
  ).resolves.toBeDefined();
});

it("leaves a deleted file's excerpt without context expansion", () => {
  const file = parse(
    [
      "diff --git a/file.ts b/file.ts",
      "deleted file mode 100644",
      "--- a/file.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-a",
      "-b",
      "-c",
      "",
    ].join("\n"),
  );
  const excerpt = { path: "file.ts", side: "old", start: 2, end: 2, caption: "" } as const;
  const rows = excerptRows(fileDiffRows(file), excerpt);

  expect(excerptLoader(excerpt, file, rows, async () => Promise.reject(new Error("unused")))).toBe(
    null,
  );
});

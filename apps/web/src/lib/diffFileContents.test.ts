import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  claimHighlightContextLoad,
  createGitDiffFileContentsLoader,
  releaseHighlightContextLoad,
} from "./diffFileContents";
import { getRenderablePatch } from "./diffRendering";

const originalLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const changedLines = originalLines.map((line, index) => (index === 29 ? "line 30 changed" : line));

function toContents(lines: ReadonlyArray<string>) {
  return `${lines.join("\n")}\n`;
}

function parsePartialFileDiff(patch: string): FileDiffMetadata {
  const renderable = getRenderablePatch(patch, "diff-panel:light", {
    compactPartialHunkOffsets: true,
  });
  if (renderable?.kind !== "files") throw new Error("Expected a parsed patch.");
  return renderable.files[0]!;
}

function partialFileDiff(): FileDiffMetadata {
  const patch = [
    "diff --git a/src/file01.ts b/src/file01.ts",
    "index 1111111..2222222 100644",
    "--- a/src/file01.ts",
    "+++ b/src/file01.ts",
    "@@ -27,7 +27,7 @@",
    " line 27",
    " line 28",
    " line 29",
    "-line 30",
    "+line 30 changed",
    " line 31",
    " line 32",
    " line 33",
    "",
  ].join("\n");
  return parsePartialFileDiff(patch);
}

function loaderReturning(oldContents: string, newContents: string) {
  return createGitDiffFileContentsLoader(
    async () => AsyncResult.success({ oldContents, newContents }),
    {
      environmentId: EnvironmentId.make("environment-diff-contents-test"),
      cwd: "/repo",
      sourceKind: "working-tree",
      baseRef: null,
      headRef: null,
      cacheKey: "diff-hash",
    },
  );
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads contents that still reproduce the patch", async () => {
    const loaded = await loaderReturning(
      toContents(originalLines),
      toContents(changedLines),
    )(partialFileDiff());

    expect(loaded.newFile.contents).toBe(toContents(changedLines));
  });

  it.each([
    {
      name: "end before the patch's hunk",
      oldLines: originalLines.slice(0, 30),
      newLines: changedLines.slice(0, 30),
    },
    {
      name: "have unchanged tails that no longer match between sides",
      oldLines: originalLines,
      newLines: [...changedLines, "line 41 appended"],
    },
    {
      name: "changed hunk lines without moving them",
      oldLines: originalLines,
      newLines: changedLines.map((line, index) => (index === 30 ? "edited since" : line)),
    },
  ])("rejects contents that $name", async ({ oldLines, newLines }) => {
    const loader = loaderReturning(toContents(oldLines), toContents(newLines));

    await expect(loader(partialFileDiff())).rejects.toThrow("changed since the diff was loaded");
  });

  it("loads a whitespace-ignored patch whose context shows one side's whitespace", async () => {
    const patch = [
      "diff --git a/src/file01.ts b/src/file01.ts",
      "index 1111111..2222222 100644",
      "--- a/src/file01.ts",
      "+++ b/src/file01.ts",
      "@@ -2,4 +2,4 @@ a",
      " b",
      " c",
      " d",
      "-e",
      "\\ No newline at end of file",
      "+E",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const loaded = await loaderReturning(
      "a\nb\n  c\nd\ne",
      "a\nb\nc\nd\nE",
    )(parsePartialFileDiff(patch));

    expect(loaded.oldFile?.contents).toBe("a\nb\n  c\nd\ne");
  });
});

describe("claimHighlightContextLoad", () => {
  it("claims a patch whose hunk starts below the top of the file once per mount", () => {
    const fileDiff = partialFileDiff();

    expect(claimHighlightContextLoad(fileDiff)).toBe(true);
    expect(claimHighlightContextLoad(fileDiff)).toBe(false);
    releaseHighlightContextLoad(fileDiff);
    expect(claimHighlightContextLoad(fileDiff)).toBe(true);
  });

  it("does not claim again after the files failed to load", async () => {
    const fileDiff = partialFileDiff();
    const loader = loaderReturning(toContents(originalLines), toContents(originalLines));

    await expect(loader(fileDiff)).rejects.toThrow("changed since the diff was loaded");
    releaseHighlightContextLoad(fileDiff);

    expect(claimHighlightContextLoad(fileDiff)).toBe(false);
  });

  it.each([
    {
      name: "a patch whose only hunk starts at the first line",
      patch: ["--- a/a.py", "+++ b/a.py", "@@ -1,2 +1,2 @@", "-old", "+new", " kept", ""],
    },
    {
      name: "an added file",
      patch: ["new file mode 100644", "--- /dev/null", "+++ b/a.py", "@@ -0,0 +1 @@", "+new", ""],
    },
  ])("leaves $name as parsed", ({ patch }) => {
    const fileDiff = parsePartialFileDiff(["diff --git a/a.py b/a.py", ...patch].join("\n"));

    expect(claimHighlightContextLoad(fileDiff)).toBe(false);
  });
});

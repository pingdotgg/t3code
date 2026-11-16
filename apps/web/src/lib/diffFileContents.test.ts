import { hydratePartialDiff, type FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { buildDiffReviewComment } from "../reviewCommentContext";
import { createGitDiffFileContentsLoader } from "./diffFileContents";
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

  it("cuts very long lines for rendering and keeps their full text for review comments", async () => {
    const longChange = `${"x".repeat(20_000)}CRITICAL_TAIL`;
    const longContext = `${"y".repeat(20_000)}CONTEXT_TAIL`;
    const oldLines = originalLines.map((line, index) => (index === 4 ? longContext : line));
    const newLines = oldLines.map((line, index) => (index === 29 ? longChange : line));
    const fileDiff = parsePartialFileDiff(
      [
        "diff --git a/src/file01.ts b/src/file01.ts",
        "index 1111111..2222222 100644",
        "--- a/src/file01.ts",
        "+++ b/src/file01.ts",
        "@@ -27,7 +27,7 @@",
        " line 27",
        " line 28",
        " line 29",
        "-line 30",
        `+${longChange}`,
        " line 31",
        " line 32",
        " line 33",
        "",
      ].join("\n"),
    );
    const commentOn = (line: number) =>
      buildDiffReviewComment({
        id: "comment",
        sectionId: "section",
        sectionTitle: "Section",
        filePath: "src/file01.ts",
        fileDiff,
        range: { start: line, side: "additions", end: line, endSide: "additions" },
        text: "",
      })?.diff;

    expect(fileDiff.additionLines[3]).toBe(
      `${"x".repeat(10_000)} … 10013 more characters not shown\n`,
    );
    expect(commentOn(30)).toBe(`@@ -0,0 +30,1 @@\n+${longChange}`);

    const loaded = await loaderReturning(toContents(oldLines), toContents(newLines))(fileDiff);
    expect(commentOn(30)).toBe(`@@ -0,0 +30,1 @@\n+${longChange}`);

    // A virtualized view hydrates a copy, then assigns it over the file the host last supplied.
    Object.assign(fileDiff, hydratePartialDiff("clone", fileDiff, loaded));
    expect(fileDiff.additionLines).toHaveLength(40);
    expect(Math.max(...fileDiff.additionLines.map((line) => line.length))).toBeLessThan(10_100);
    expect(commentOn(30)).toBe(`@@ -0,0 +30,1 @@\n+${longChange}`);
    expect(commentOn(5)).toBe(`@@ -5,1 +5,1 @@\n ${longContext}`);
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

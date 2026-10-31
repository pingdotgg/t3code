import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createGitDiffFileContentsLoader } from "./diffFileContents";
import { getRenderablePatch } from "./diffRendering";

const originalLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const changedLines = originalLines.map((line, index) => (index === 29 ? "line 30 changed" : line));

function toContents(lines: ReadonlyArray<string>) {
  return `${lines.join("\n")}\n`;
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
  const renderable = getRenderablePatch(patch, "diff-panel:light", {
    compactPartialHunkOffsets: true,
  });
  if (renderable?.kind !== "files") throw new Error("Expected a parsed patch.");
  return renderable.files[0]!;
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

function loadOutcome(loader: FileDiffContentsLoader, fileDiff: FileDiffMetadata) {
  return loader(fileDiff).then(
    () => "hydrated with stale contents",
    () => "rejected",
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

  it("rejects contents that end before the patch's hunk", async () => {
    const loader = loaderReturning(
      toContents(originalLines.slice(0, 30)),
      toContents(changedLines.slice(0, 30)),
    );

    await expect(loadOutcome(loader, partialFileDiff())).resolves.toBe("rejected");
  });

  it("rejects contents whose unchanged tail no longer matches between sides", async () => {
    const loader = loaderReturning(
      toContents(originalLines),
      toContents([...changedLines, "line 41 appended"]),
    );

    await expect(loadOutcome(loader, partialFileDiff())).resolves.toBe("rejected");
  });
});

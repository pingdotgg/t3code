import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileDiffStagingPaths, sectionPaths } from "./diffStaging";

const source = (files?: ReviewDiffPreviewSource["files"]): ReviewDiffPreviewSource => ({
  id: "unstaged",
  kind: "unstaged",
  title: "Changes",
  baseRef: null,
  headRef: null,
  diff: "",
  diffHash: "hash",
  truncated: files === undefined,
  ...(files ? { files } : {}),
});

const statusFile = (path: string, staged: "none" | "partial" | "all") => ({
  path,
  insertions: 1,
  deletions: 0,
  staged,
});

describe("fileDiffStagingPaths", () => {
  it("stages both sides of a rename", () => {
    expect(
      fileDiffStagingPaths({ name: "src/new.ts", prevName: "src/old.ts" } as FileDiffMetadata),
    ).toEqual(["src/new.ts", "src/old.ts"]);
    expect(fileDiffStagingPaths({ name: "README.md" } as FileDiffMetadata)).toEqual(["README.md"]);
  });
});

describe("sectionPaths", () => {
  const statusFiles = [
    statusFile("staged.ts", "all"),
    statusFile("partial.ts", "partial"),
    statusFile("untracked.ts", "none"),
  ];

  it("takes every file in the section from status, even ones the preview left out", () => {
    const truncated = source();
    expect(
      sectionPaths({ section: "unstaged", statusFiles, source: truncated, renderedFiles: [] }),
    ).toEqual(["partial.ts", "untracked.ts"]);
    expect(
      sectionPaths({ section: "staged", statusFiles, source: truncated, renderedFiles: [] }),
    ).toEqual(["staged.ts", "partial.ts"]);
  });

  it("falls back to the preview's files when status has no staged state", () => {
    expect(
      sectionPaths({
        section: "unstaged",
        statusFiles: [{ path: "a.ts", insertions: 1, deletions: 0 }],
        source: source([
          { path: "src/new.ts", previousPath: "src/old.ts", additions: 0, deletions: 0 },
        ]),
        renderedFiles: [],
      }),
    ).toEqual(["src/new.ts", "src/old.ts"]);
  });
});

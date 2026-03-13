import { describe, expect, it } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { areSelectedLineRangesEqual, buildFileKeyByPathIndex } from "./DiffPanel.logic";

function makeFileDiff(
  input: Partial<Pick<FileDiffMetadata, "name" | "prevName" | "cacheKey">>,
): FileDiffMetadata {
  return {
    name: input.name ?? null,
    prevName: input.prevName ?? null,
    cacheKey: input.cacheKey ?? null,
  } as FileDiffMetadata;
}

describe("buildFileKeyByPathIndex", () => {
  it("indexes both the previous and current path for renamed files", () => {
    const renamedFile = makeFileDiff({
      name: "b/src/new-name.ts",
      prevName: "a/src/old-name.ts",
      cacheKey: "rename-cache-key",
    });

    const fileKeyByPath = buildFileKeyByPathIndex([renamedFile]);

    expect(fileKeyByPath.get("src/old-name.ts")).toBe("rename-cache-key");
    expect(fileKeyByPath.get("src/new-name.ts")).toBe("rename-cache-key");
  });

  it("keeps a single entry when the normalized paths are identical", () => {
    const unchangedFile = makeFileDiff({
      name: "b/src/example.ts",
      prevName: "a/src/example.ts",
      cacheKey: "same-cache-key",
    });

    const fileKeyByPath = buildFileKeyByPathIndex([unchangedFile]);

    expect([...fileKeyByPath.entries()]).toEqual([["src/example.ts", "same-cache-key"]]);
  });
});

describe("areSelectedLineRangesEqual", () => {
  it("treats forward and backward single-side selections as equal", () => {
    expect(
      areSelectedLineRangesEqual(
        { start: 5, end: 10, side: "additions" },
        { start: 10, end: 5, side: "additions" },
      ),
    ).toBe(true);
  });
});

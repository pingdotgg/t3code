import { describe, expect, it } from "vitest";
import {
  computeLineDiff,
  diffStats,
  extractDiffPreviews,
  mergeDiffPreviews,
  type InlineDiffHunk,
} from "./inlineDiff";

describe("computeLineDiff", () => {
  it("returns empty array for two empty strings", () => {
    expect(computeLineDiff("", "")).toEqual([]);
  });

  it("marks all lines as additions when old is empty", () => {
    const result = computeLineDiff("", "a\nb");
    expect(result).toEqual([
      { type: "addition", content: "a" },
      { type: "addition", content: "b" },
    ]);
  });

  it("marks all lines as deletions when new is empty", () => {
    const result = computeLineDiff("a\nb", "");
    expect(result).toEqual([
      { type: "deletion", content: "a" },
      { type: "deletion", content: "b" },
    ]);
  });

  it("identifies context lines around a single-line change", () => {
    const result = computeLineDiff("a\nb\nc", "a\nB\nc");
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "deletion", content: "b" },
      { type: "addition", content: "B" },
      { type: "context", content: "c" },
    ]);
  });

  it("handles identical strings as all context", () => {
    const result = computeLineDiff("x\ny\nz", "x\ny\nz");
    expect(result).toEqual([
      { type: "context", content: "x" },
      { type: "context", content: "y" },
      { type: "context", content: "z" },
    ]);
  });

  it("handles multi-line insertions", () => {
    const result = computeLineDiff("a\nc", "a\nb1\nb2\nc");
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "addition", content: "b1" },
      { type: "addition", content: "b2" },
      { type: "context", content: "c" },
    ]);
  });

  it("handles multi-line deletions", () => {
    const result = computeLineDiff("a\nb1\nb2\nc", "a\nc");
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "deletion", content: "b1" },
      { type: "deletion", content: "b2" },
      { type: "context", content: "c" },
    ]);
  });

  it("strips trailing newlines without phantom empty lines", () => {
    const result = computeLineDiff("a\nb\n", "a\nB\n");
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "deletion", content: "b" },
      { type: "addition", content: "B" },
    ]);
  });

  it("falls back to all-delete + all-add for inputs exceeding LCS limit", () => {
    const bigOld = Array.from({ length: 250 }, (_, i) => `old-${i}`).join("\n");
    const bigNew = Array.from({ length: 250 }, (_, i) => `new-${i}`).join("\n");
    const result = computeLineDiff(bigOld, bigNew);
    const deletions = result.filter((l) => l.type === "deletion");
    const additions = result.filter((l) => l.type === "addition");
    expect(deletions).toHaveLength(250);
    expect(additions).toHaveLength(250);
    expect(result.filter((l) => l.type === "context")).toHaveLength(0);
  });
});

describe("extractDiffPreviews", () => {
  it("returns empty array for null payload", () => {
    expect(extractDiffPreviews(null)).toEqual([]);
  });

  it("returns empty array when data is missing", () => {
    expect(extractDiffPreviews({})).toEqual([]);
  });

  it("returns empty array for unknown tool name", () => {
    expect(
      extractDiffPreviews({
        data: { toolName: "Bash", input: { command: "ls" } },
      }),
    ).toEqual([]);
  });

  it("extracts edit hunk from Claude Edit tool payload", () => {
    const result = extractDiffPreviews({
      data: {
        toolName: "Edit",
        input: {
          file_path: "src/foo.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("src/foo.ts");
    expect(result[0]!.operation).toBe("edit");
    expect(result[0]!.lines).toEqual([
      { type: "deletion", content: "const x = 1;" },
      { type: "addition", content: "const x = 2;" },
    ]);
  });

  it("extracts write hunk from Write tool payload", () => {
    const result = extractDiffPreviews({
      data: {
        toolName: "Write",
        input: {
          file_path: "src/new.ts",
          content: "line1\nline2",
        },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("src/new.ts");
    expect(result[0]!.operation).toBe("write");
    expect(result[0]!.lines).toEqual([
      { type: "addition", content: "line1" },
      { type: "addition", content: "line2" },
    ]);
  });

  it("handles edit with context lines", () => {
    const result = extractDiffPreviews({
      data: {
        toolName: "Edit",
        input: {
          file_path: "f.ts",
          old_string: "a\nb\nc",
          new_string: "a\nB\nc",
        },
      },
    });
    expect(result).toHaveLength(1);
    const lines = result[0]!.lines;
    expect(lines[0]).toEqual({ type: "context", content: "a" });
    expect(lines[1]).toEqual({ type: "deletion", content: "b" });
    expect(lines[2]).toEqual({ type: "addition", content: "B" });
    expect(lines[3]).toEqual({ type: "context", content: "c" });
  });

  it("truncates large diffs", () => {
    const bigOld = Array.from({ length: 50 }, (_, i) => `old-${i}`).join("\n");
    const bigNew = Array.from({ length: 50 }, (_, i) => `new-${i}`).join("\n");
    const result = extractDiffPreviews({
      data: {
        toolName: "Edit",
        input: { file_path: "big.ts", old_string: bigOld, new_string: bigNew },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.lines.length).toBeLessThanOrEqual(40);
    expect(result[0]!.fullLines.length).toBeGreaterThan(40);
    expect(result[0]!.truncated).toBe(true);
  });

  it("computes stats from full diff before truncation", () => {
    const bigOld = Array.from({ length: 50 }, (_, i) => `old-${i}`).join("\n");
    const bigNew = Array.from({ length: 50 }, (_, i) => `new-${i}`).join("\n");
    const result = extractDiffPreviews({
      data: {
        toolName: "Edit",
        input: { file_path: "big.ts", old_string: bigOld, new_string: bigNew },
      },
    });
    expect(result[0]!.stats).toEqual({ additions: 50, deletions: 50 });
  });
});

describe("mergeDiffPreviews", () => {
  const hunkA: InlineDiffHunk = {
    filePath: "a.ts",
    operation: "edit",
    lines: [{ type: "context", content: "a" }],
    fullLines: [{ type: "context", content: "a" }],
    truncated: false,
    stats: { additions: 0, deletions: 0 },
    patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n a",
  };
  const hunkB: InlineDiffHunk = {
    filePath: "b.ts",
    operation: "write",
    lines: [{ type: "addition", content: "b" }],
    fullLines: [{ type: "addition", content: "b" }],
    truncated: false,
    stats: { additions: 1, deletions: 0 },
    patch: "--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1,1 @@\n+b",
  };
  const hunkAUpdated: InlineDiffHunk = {
    filePath: "a.ts",
    operation: "edit",
    lines: [{ type: "addition", content: "updated" }],
    fullLines: [{ type: "addition", content: "updated" }],
    truncated: false,
    stats: { additions: 1, deletions: 0 },
    patch: "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+updated",
  };

  it("returns b when a is empty", () => {
    expect(mergeDiffPreviews([], [hunkB])).toEqual([hunkB]);
  });

  it("returns a when b is empty", () => {
    expect(mergeDiffPreviews([hunkA], [])).toEqual([hunkA]);
  });

  it("concatenates hunks for different files", () => {
    const result = mergeDiffPreviews([hunkA], [hunkB]);
    expect(result).toHaveLength(2);
  });

  it("deduplicates by filePath keeping latest from b", () => {
    const result = mergeDiffPreviews([hunkA], [hunkAUpdated]);
    expect(result).toHaveLength(1);
    expect(result[0]!.lines[0]!.content).toBe("updated");
  });
});

describe("diffStats", () => {
  it("counts additions and deletions", () => {
    const lines = [
      { type: "context" as const, content: "x" },
      { type: "addition" as const, content: "a" },
      { type: "addition" as const, content: "b" },
      { type: "deletion" as const, content: "c" },
    ];
    expect(diffStats(lines)).toEqual({ additions: 2, deletions: 1 });
  });

  it("returns zeros for all-context lines", () => {
    const lines = [{ type: "context" as const, content: "x" }];
    expect(diffStats(lines)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("extractDiffPreviews for apply_patch", () => {
  const updatePatch = [
    "*** Begin Patch",
    "*** Update File: apps/web/src/example.ts",
    "@@ -1,3 +1,3 @@",
    " context line",
    "-removed line",
    "+added line",
    "*** End Patch",
  ].join("\n");

  it("parses an Update File hunk into a file_change preview", () => {
    const result = extractDiffPreviews({
      data: {
        toolName: "apply_patch",
        input: { patchText: updatePatch },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("apps/web/src/example.ts");
    expect(result[0]!.operation).toBe("edit");
    expect(result[0]!.stats).toEqual({ additions: 1, deletions: 1 });
  });

  it("parses an Add File section as a write preview", () => {
    const addPatch = [
      "*** Begin Patch",
      "*** Add File: apps/web/src/new.ts",
      "export const value = 1;",
      "export const other = 2;",
      "*** End Patch",
    ].join("\n");
    const result = extractDiffPreviews({
      data: {
        toolName: "apply_patch",
        input: { patchText: addPatch },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("apps/web/src/new.ts");
    expect(result[0]!.operation).toBe("write");
    expect(result[0]!.stats.additions).toBe(2);
  });

  it("parses multiple files in a single patchText", () => {
    const multiPatch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-a",
      "+A",
      "*** Update File: b.ts",
      "@@",
      "-b",
      "+B",
      "*** End Patch",
    ].join("\n");
    const result = extractDiffPreviews({
      data: {
        toolName: "apply_patch",
        input: { patchText: multiPatch },
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.filePath).toBe("a.ts");
    expect(result[1]!.filePath).toBe("b.ts");
  });

  it("accepts alternate input keys (patch, diff) used by other providers", () => {
    const result = extractDiffPreviews({
      data: {
        toolName: "Patch",
        input: { patch: updatePatch },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("apps/web/src/example.ts");
  });

  it("returns [] when the toolName isn't a known patch/edit/write variant", () => {
    expect(
      extractDiffPreviews({
        data: { toolName: "bash", input: { patchText: updatePatch } },
      }),
    ).toEqual([]);
  });
});

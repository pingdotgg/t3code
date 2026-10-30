import { describe, expect, it } from "vite-plus/test";

import { patchLines } from "./patchLines";

const kinds = (patch: string, maxLines = 100) =>
  patchLines(patch, maxLines).lines.map((line) => line.kind);

describe("patchLines", () => {
  it("ends a hunk by its counts, so removed lines that look like headers stay deletions", () => {
    const patch = [
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,2 +1,1 @@",
      "--- not a header",
      " kept",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(kinds(patch)).toEqual([
      "header",
      "header",
      "hunk",
      "deletion",
      "context",
      "header",
      "header",
      "hunk",
      "deletion",
      "addition",
      "context",
    ]);
  });

  it("classifies hunks without ranges until the next hunk or file", () => {
    expect(kinds("@@\n-a\n+b\n c\n@@\n+d\ndiff --git a/x b/x\n")).toEqual([
      "hunk",
      "deletion",
      "addition",
      "context",
      "hunk",
      "addition",
      "header",
    ]);
  });

  it("caps the rendered lines and reports how many were hidden", () => {
    const patch = `@@ -0,0 +1,5 @@\n${["a", "b", "c", "d", "e"].map((line) => `+${line}`).join("\n")}\n`;
    const result = patchLines(patch, 3);
    expect(result.lines.map((line) => line.text)).toEqual(["@@ -0,0 +1,5 @@", "+a", "+b"]);
    expect(result.hiddenCount).toBe(3);
  });
});

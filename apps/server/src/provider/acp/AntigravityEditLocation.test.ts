import { describe, expect, it } from "vite-plus/test";

import { ANTIGRAVITY_EDIT_DIFF_OMITTED, antigravityEditPatch } from "./AntigravityEditLocation.ts";

const path = "/workspace/app.ts";
const file = Array.from({ length: 20 }, (_, i) =>
  i === 9
    ? "const target = 10;"
    : i === 14
      ? "const other = 15;"
      : `const line${i + 1} = ${i + 1};`,
).join("\n");
const replace = { TargetContent: "const target = 10;", ReplacementContent: "const target = 100;" };
const header = `--- ${path}\n+++ ${path}\n`;

describe("antigravityEditPatch", () => {
  it("keeps the announced start line from rawInput or the tool location", () => {
    const expected = `${header}@@ -10,1 +10,1 @@\n-const target = 10;\n+const target = 100;\n`;
    expect(
      antigravityEditPatch({ path, rawInput: { ...replace, StartLine: 10, EndLine: 10 } }),
    ).toBe(expected);
    expect(antigravityEditPatch({ path, rawInput: replace, locations: [{ path, line: 10 }] })).toBe(
      expected,
    );
  });

  it("finds an unannounced snippet in the pre-edit file", () => {
    expect(antigravityEditPatch({ path, rawInput: replace, readPreEditFile: () => file })).toBe(
      `${header}@@ -10,1 +10,1 @@\n-const target = 10;\n+const target = 100;\n`,
    );
  });

  it("labels repeated or unmatched snippets instead of placing them at line 1", () => {
    const snippet = `${header}@@ -1,1 +1,1 @@ snippet, line unknown\n-const target = 10;\n+const target = 100;\n`;
    for (const readPreEditFile of [
      () => `${file}\n${file}`,
      () => "unrelated\n",
      () => undefined,
      undefined,
    ]) {
      expect(antigravityEditPatch({ path, rawInput: replace, readPreEditFile })).toBe(snippet);
    }
  });

  it("places each replacement chunk and shifts later chunks by earlier line changes", () => {
    const patch = antigravityEditPatch({
      path,
      rawInput: {
        ReplacementChunks: [
          {
            TargetContent: "const other = 15;\n",
            ReplacementContent: "const other = 150;\n",
            StartLine: 15,
            EndLine: 15,
          },
          {
            TargetContent: "const target = 10;\n",
            ReplacementContent: "const target = 100;\nconst added = 1;\n",
            StartLine: 10,
            EndLine: 10,
          },
          { TargetContent: "missing", ReplacementContent: "still missing" },
        ],
      },
      readPreEditFile: () => file,
    });
    expect(patch).toBe(
      [
        header.trimEnd(),
        "@@ -10,1 +10,2 @@",
        "-const target = 10;",
        "+const target = 100;",
        "+const added = 1;",
        "@@ -15,1 +16,1 @@",
        "-const other = 15;",
        "+const other = 150;",
        "",
        header.trimEnd(),
        "@@ -1,1 +1,1 @@ snippet, line unknown",
        "-missing",
        "+still missing",
        "",
      ].join("\n"),
    );
  });

  it("leaves whole-file writes and unknown inputs to the generic diff", () => {
    expect(antigravityEditPatch({ path, rawInput: { CodeContent: "x" } })).toBeUndefined();
    expect(antigravityEditPatch({ path, rawInput: undefined })).toBeUndefined();
  });

  it("omits the preview once an edit exceeds the shared diff budget", () => {
    const lines = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix} ${index} ${"x".repeat(8)}`).join("\n");
    // A 7,000-line wholesale replacement, as one chunk.
    expect(
      antigravityEditPatch({
        path,
        rawInput: {
          TargetContent: lines("old", 7_000),
          ReplacementContent: lines("new", 7_000),
          StartLine: 1,
        },
      }),
    ).toBe(ANTIGRAVITY_EDIT_DIFF_OMITTED);
    // Chunks that each fit, but not together.
    const chunk = (start: number) => ({
      TargetContent: lines(`old-${start}`, 300),
      ReplacementContent: lines(`new-${start}`, 300),
      StartLine: start,
    });
    expect(
      antigravityEditPatch({
        path,
        rawInput: { ReplacementChunks: [chunk(1), chunk(1_000)] },
      }),
    ).toBe(ANTIGRAVITY_EDIT_DIFF_OMITTED);
    // Text over the size limit is not diffed at all.
    expect(
      antigravityEditPatch({
        path,
        rawInput: {
          TargetContent: "a".repeat(200_000),
          ReplacementContent: "b".repeat(100_000),
          StartLine: 1,
        },
      }),
    ).toBe(ANTIGRAVITY_EDIT_DIFF_OMITTED);
    expect(antigravityEditPatch({ path, rawInput: { ReplacementChunks: [chunk(1)] } })).toMatch(
      /^@@ -1,300 \+1,300 @@$/m,
    );
  });
});

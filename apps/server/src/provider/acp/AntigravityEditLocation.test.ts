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
  it("finds the target inside the announced search range, in either argument casing", () => {
    const expected = `${header}@@ -10,1 +10,1 @@\n-const target = 10;\n+const target = 100;\n`;
    const readPreEditFile = () => file;
    for (const rawInput of [
      { ...replace, StartLine: 5, EndLine: 20 },
      {
        target_content: replace.TargetContent,
        replacement_content: replace.ReplacementContent,
        start_line: 5,
        end_line: 20,
      },
      {
        replacement_chunks: [
          {
            target_content: replace.TargetContent,
            replacement_content: replace.ReplacementContent,
            start_line: 5,
            end_line: 20,
          },
        ],
      },
      // Like the runtime, a present PascalCase value wins, and a 0 line means unspecified.
      { ...replace, target_content: "const other = 15;", StartLine: 5, EndLine: 0 },
    ]) {
      expect(antigravityEditPatch({ path, rawInput, readPreEditFile })).toBe(expected);
    }
    for (const rawInput of [replace, { ReplacementChunks: [replace] }]) {
      expect(
        antigravityEditPatch({ path, rawInput, locations: [{ path, line: 5 }], readPreEditFile }),
      ).toBe(expected);
    }
    // A hunk replaces whole lines, so a match inside a line is not a placement.
    expect(
      antigravityEditPatch({
        path,
        rawInput: { TargetContent: "10", ReplacementContent: "100" },
        readPreEditFile,
      }),
    ).toMatch(/ snippet, line unknown$/m);
    // The range start is not the target's line: without the file, or outside the range, it stays unplaced.
    const snippet = `${header}@@ -1,1 +1,1 @@ snippet, line unknown\n-const target = 10;\n+const target = 100;\n`;
    expect(
      antigravityEditPatch({ path, rawInput: { ...replace, StartLine: 5, EndLine: 20 } }),
    ).toBe(snippet);
    expect(
      antigravityEditPatch({
        path,
        rawInput: { ...replace, StartLine: 11, EndLine: 20 },
        readPreEditFile,
      }),
    ).toBe(snippet);
  });

  it("finds an unannounced snippet in the pre-edit file", () => {
    const expected = `${header}@@ -10,1 +10,1 @@\n-const target = 10;\n+const target = 100;\n`;
    expect(antigravityEditPatch({ path, rawInput: replace, readPreEditFile: () => file })).toBe(
      expected,
    );
    const crlf = file.replaceAll("\n", "\r\n");
    expect(antigravityEditPatch({ path, rawInput: replace, readPreEditFile: () => crlf })).toBe(
      expected,
    );
    // A target written with CRLF previews the same lines, without carriage returns.
    expect(
      antigravityEditPatch({
        path,
        rawInput: {
          TargetContent: "const target = 10;\r\n",
          ReplacementContent: "const target = 100;\r\n",
        },
        readPreEditFile: () => crlf,
      }),
    ).toBe(expected);
    // A change to the line ending alone has no LF hunk to place.
    const endingOnly = {
      TargetContent: "const target = 10;\r\n",
      ReplacementContent: "const target = 10;\n",
    };
    for (const readPreEditFile of [() => crlf, undefined]) {
      expect(antigravityEditPatch({ path, rawInput: endingOnly, readPreEditFile })).toBe(
        ANTIGRAVITY_EDIT_DIFF_OMITTED,
      );
    }
    // A multi-line target written with LF still finds its lines in a CRLF file.
    expect(
      antigravityEditPatch({
        path,
        rawInput: {
          TargetContent: "const line9 = 9;\nconst target = 10;",
          ReplacementContent: "const line9 = 9;\nconst target = 100;",
        },
        readPreEditFile: () => crlf,
      }),
    ).toMatch(/^@@ -9,2 \+9,2 @@$/m);
  });

  it("omits the preview when a chunk adds or removes a line break at its end", () => {
    // Whether that splits or joins lines depends on what follows the match.
    for (const [TargetContent, ReplacementContent] of [
      ["const line3 = 3;", "x\n"],
      ["const line3 = 3;\n", "x"],
      ["const line20 = 20;", "x\n"],
      // Clearing the last line of a file with no final newline removes the line.
      ["const line20 = 20;", ""],
    ]) {
      expect(
        antigravityEditPatch({
          path,
          rawInput: { TargetContent, ReplacementContent },
          readPreEditFile: () => file,
        }),
      ).toBe(ANTIGRAVITY_EDIT_DIFF_OMITTED);
    }
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
      ].join("\n"),
    );
  });

  it("omits the preview when only some chunks can be placed", () => {
    const patch = antigravityEditPatch({
      path,
      rawInput: {
        ReplacementChunks: [
          {
            TargetContent: "const target = 10;\n",
            ReplacementContent: "const target = 100;\n",
            StartLine: 10,
            EndLine: 10,
          },
          { TargetContent: "missing", ReplacementContent: "still missing" },
        ],
      },
      readPreEditFile: () => file,
    });
    expect(patch).toBe(ANTIGRAVITY_EDIT_DIFF_OMITTED);
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
      /^@@ -1,300 \+1,300 @@/m,
    );
  });
});

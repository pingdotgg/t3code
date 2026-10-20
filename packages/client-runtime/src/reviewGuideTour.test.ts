import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { PullRequestReviewGuideStop } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  excerptExpansionOldContents,
  excerptRows,
  fileDiffRows,
  letterStopNotes,
  rowsToPatch,
  reviewGuideStopProgress,
  stepTourPosition,
} from "./reviewGuideTour.js";

const PATCH = `diff --git a/src/tray.ts b/src/tray.ts
--- a/src/tray.ts
+++ b/src/tray.ts
@@ -10,5 +10,6 @@ function tray()
 const a = 1;
-const size = pick();
+const size = "xs";
+const variant = "tray";
 const b = 2;
 const c = 3;
 const d = 4;
@@ -40,3 +41,2 @@ function footer()
 keep();
-dropped();
 tail();
`;

function parse(patch: string) {
  const file = parsePatchFiles(patch, `test:${patch.length}`)[0]?.files[0];
  if (file === undefined) throw new Error("patch did not parse");
  return file;
}

const rows = fileDiffRows(parse(PATCH));

function stop(overrides: Partial<PullRequestReviewGuideStop>): PullRequestReviewGuideStop {
  return {
    title: "Stop",
    summary: "",
    attention: null,
    excerpts: [],
    files: [],
    notes: [],
    questions: [],
    ...overrides,
  };
}

describe("stepTourPosition", () => {
  it("holds the tour to its first and last stops", () => {
    expect(stepTourPosition(0, -1, 3)).toBe(0);
    expect(stepTourPosition(0, 1, 3)).toBe(1);
    expect(stepTourPosition(2, 1, 3)).toBe(2);
  });
});

describe("reviewGuideStopProgress", () => {
  it("counts each chapter file once and completes when its last file is reviewed", () => {
    const chapter = stop({
      files: [
        { path: "a.ts", note: "" },
        { path: "b.ts", note: "" },
      ],
      excerpts: [{ path: "a.ts", side: "new", start: 1, end: 3, caption: "" }],
    });
    const viewed = new Set(["a.ts"]);
    expect(reviewGuideStopProgress(chapter, (path) => viewed.has(path))).toEqual({
      paths: ["a.ts", "b.ts"],
      reviewedCount: 1,
      reviewed: false,
    });
    viewed.add("b.ts");
    expect(reviewGuideStopProgress(chapter, (path) => viewed.has(path)).reviewed).toBe(true);
    viewed.delete("a.ts");
    expect(reviewGuideStopProgress(chapter, (path) => viewed.has(path)).reviewed).toBe(false);
  });

  it("does not mark a context-only chapter as reviewed", () => {
    expect(reviewGuideStopProgress(stop({}), () => true)).toEqual({
      paths: [],
      reviewedCount: 0,
      reviewed: false,
    });
  });
});

describe("fileDiffRows", () => {
  it("numbers both sides through context, deletions and additions", () => {
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ["context", 10, 10],
      ["deletion", 11, null],
      ["addition", null, 11],
      ["addition", null, 12],
      ["context", 12, 13],
      ["context", 13, 14],
      ["context", 14, 15],
      ["context", 40, 41],
      ["deletion", 41, null],
      ["context", 42, 42],
    ]);
  });
});

describe("excerptRows", () => {
  it("brings the replaced lines along with an excerpt that starts on an addition", () => {
    const shown = excerptRows(rows, { side: "new", start: 11, end: 12 });
    expect(shown.map((row) => row.kind)).toEqual(["deletion", "addition", "addition"]);
  });

  it("selects old-side lines for a removal and stops at the hunk boundary", () => {
    const shown = excerptRows(rows, { side: "old", start: 41, end: 41 });
    expect(shown.map((row) => [row.kind, row.oldLine])).toEqual([["deletion", 41]]);
  });

  it("returns nothing for a range outside the diff", () => {
    expect(excerptRows(rows, { side: "new", start: 100, end: 120 })).toEqual([]);
  });
});

describe("rowsToPatch", () => {
  it("cuts a slice that parses back to the same lines and numbers", () => {
    const shown = excerptRows(rows, { side: "new", start: 10, end: 13 });
    const slice = parse(rowsToPatch("src/tray.ts", "src/tray.ts", shown));
    expect(fileDiffRows(slice).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual(
      shown.map((row) => [row.kind, row.oldLine, row.newLine]),
    );
  });

  it("starts a hunk per source hunk so separate hunks stay separate", () => {
    const shown = excerptRows(rows, { side: "old", start: 14, end: 42 });
    const patch = rowsToPatch("src/tray.ts", "src/tray.ts", shown);
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
    expect(patch).toContain("@@ -14,1 +15,1 @@");
    expect(patch).toContain("@@ -40,3 +41,2 @@");
  });
});

describe("excerptExpansionOldContents", () => {
  const newFile = Array.from({ length: 50 }, (_, index) => `line ${index + 1}\n`);
  newFile.splice(
    9,
    6,
    "const a = 1;\n",
    'const size = "xs";\n',
    'const variant = "tray";\n',
    "const b = 2;\n",
    "const c = 3;\n",
    "const d = 4;\n",
  );
  newFile.splice(40, 2, "keep();\n", "tail();\n");
  const newContents = newFile.join("");

  it("puts back only the excerpt's lines and keeps both sides numbered as in the file", () => {
    const shown = excerptRows(rows, { side: "new", start: 11, end: 12 });
    const old = excerptExpansionOldContents(newContents, shown);
    if (old === null) throw new Error("expected contents");
    const oldLines = old.split("\n");
    expect(oldLines[10]).toBe("const size = pick();");
    expect(oldLines[9]).toBe("const a = 1;");
    expect(oldLines[11]).toBe("const b = 2;");
    expect(oldLines.length).toBe(newContents.split("\n").length - 1);
  });

  it("does not try to expand an excerpt that spans hunks", () => {
    const shown = excerptRows(rows, { side: "old", start: 14, end: 42 });
    expect(excerptExpansionOldContents(newContents, shown)).toBeNull();
  });
});

describe("letterStopNotes", () => {
  it("letters notes in guide order and pins each to the excerpt that holds its line", () => {
    const { lettered, byExcerpt } = letterStopNotes(
      stop({
        excerpts: [
          { path: "a.ts", side: "new", start: 1, end: 5, caption: "" },
          { path: "b.ts", side: "new", start: 10, end: 12, caption: "" },
        ],
        notes: [
          { path: "b.ts", line: 11, title: "First", body: "" },
          { path: "a.ts", line: 2, title: "Second", body: "" },
          { path: "a.ts", line: 2, title: "Third", body: "" },
          { path: "c.ts", line: 1, title: "Unanchored", body: "" },
        ],
      }),
    );
    expect(lettered.map((entry) => entry.marker)).toEqual(["A", "B", "C", "D"]);
    expect(byExcerpt).toEqual([
      [
        {
          line: 2,
          markers: [
            { marker: "B", title: "Second" },
            { marker: "C", title: "Third" },
          ],
        },
      ],
      [{ line: 11, markers: [{ marker: "A", title: "First" }] }],
    ]);
  });
});

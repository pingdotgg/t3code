import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import {
  excerptExpansionOldContents,
  excerptRows,
  fileDiffRows,
  rowsToPatch,
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

const LINE_ENDING_CASES = [
  {
    name: "adding the final newline",
    body: "@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n",
    oldContents: "same",
    newContents: "same\n",
  },
  {
    name: "removing the final newline",
    body: "@@ -1 +1 @@\n-same\n+same\n\\ No newline at end of file\n",
    oldContents: "same\n",
    newContents: "same",
  },
  {
    name: "neither side having a final newline",
    body: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    oldContents: "old",
    newContents: "new",
  },
  {
    name: "CRLF lines",
    body: "@@ -1 +1 @@\n-old\r\n+new\r\n",
    oldContents: "old\r\n",
    newContents: "new\r\n",
  },
  {
    name: "changing CRLF to LF",
    body: "@@ -1 +1 @@\n-same\r\n+same\n",
    oldContents: "same\r\n",
    newContents: "same\n",
  },
  {
    name: "context without a final newline",
    body: "@@ -1,2 +1,2 @@\n-old\n+new\n tail\n\\ No newline at end of file\n",
    oldContents: "old\ntail",
    newContents: "new\ntail",
  },
  {
    name: "CRLF context",
    body: "@@ -1,2 +1,2 @@\n-old\r\n+new\r\n tail\r\n",
    oldContents: "old\r\ntail\r\n",
    newContents: "new\r\ntail\r\n",
  },
].map(({ body, ...testCase }) => ({
  ...testCase,
  patch: `diff --git a/src/tray.ts b/src/tray.ts\n--- a/src/tray.ts\n+++ b/src/tray.ts\n${body}`,
  start: 1,
  end: 2,
}));

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
});

describe("rowsToPatch", () => {
  it.each([{ name: "LF slice", patch: PATCH, start: 10, end: 13 }, ...LINE_ENDING_CASES])(
    "cuts a slice that parses back to the same lines and numbers: $name",
    ({ patch, start, end }) => {
      const original = parse(patch);
      const shown = excerptRows(fileDiffRows(original), { side: "new", start, end });
      const slice = parse(rowsToPatch("src/tray.ts", "src/tray.ts", shown));
      expect(fileDiffRows(slice)).toEqual(shown);
      expect(slice.hunks.map((hunk) => [hunk.noEOFCRDeletions, hunk.noEOFCRAdditions])).toEqual(
        original.hunks
          .filter((_, index) => shown.some((row) => row.hunk === index))
          .map((hunk) => [hunk.noEOFCRDeletions, hunk.noEOFCRAdditions]),
      );
    },
  );

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

  it.each([
    {
      name: "LF slice",
      patch: PATCH,
      start: 11,
      end: 12,
      newContents,
      oldContents: [...newFile.slice(0, 10), "const size = pick();\n", ...newFile.slice(12)].join(
        "",
      ),
    },
    ...LINE_ENDING_CASES,
    {
      name: "partial replacement of an unterminated old EOF",
      patch:
        "diff --git a/src/tray.ts b/src/tray.ts\n--- a/src/tray.ts\n+++ b/src/tray.ts\n@@ -1 +1,3 @@\n-a\n\\ No newline at end of file\n+a\n+b\n+c\n",
      start: 1,
      end: 1,
      newContents: "a\nb\nc\n",
      oldContents: "a\nb\nc\n",
    },
  ])(
    "puts back only the excerpt's lines and keeps both sides numbered as in the file: $name",
    ({ patch, start, end, newContents, oldContents }) => {
      const shown = excerptRows(fileDiffRows(parse(patch)), { side: "new", start, end });
      expect(excerptExpansionOldContents(newContents, shown)).toBe(oldContents);
    },
  );

  it("does not try to expand an excerpt that spans hunks", () => {
    const shown = excerptRows(rows, { side: "old", start: 14, end: 42 });
    expect(excerptExpansionOldContents(newContents, shown)).toBeNull();
  });
});

import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { applyPatch } from "diff";
import { describe, expect, it } from "vite-plus/test";

import {
  azureDevOpsFileDiffPatch,
  azureDevOpsFilePatch,
  byteLength,
  formatAzureDevOpsDiffCursor,
  MAX_FILE_DIFF_EDITS,
  parseAzureDevOpsDiffCursor,
} from "./azureDevOpsDiff.ts";
import type { AzureDevOpsChangeEntry, AzureDevOpsDiffBlock } from "./azureDevOpsPullRequestJson.ts";

function change(overrides: Partial<AzureDevOpsChangeEntry> = {}): AzureDevOpsChangeEntry {
  return {
    path: "README.md",
    oldPath: "README.md",
    changeKind: "change",
    objectId: "8f80",
    originalObjectId: "0ca4",
    ...overrides,
  };
}

function texts(oldContents: string, newContents: string, binary = false) {
  return { oldContents, newContents, binary };
}

describe("azureDevOpsFilePatch", () => {
  it("writes a changed file as the unified patch every diff viewer already reads", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\ntwo\nthree\n", "one\ntwo again\nthree\n"),
    });

    expect(patch.truncated).toBe(false);
    expect(patch.section).toBe(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+two again",
        " three",
        "",
      ].join("\n"),
    );
  });

  it("names the side a deleted file no longer has as /dev/null", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "OLD.md", oldPath: "OLD.md", changeKind: "deleted" }),
      texts: texts("gone\n", ""),
    });

    expect(patch.section).toContain("deleted file mode 100644");
    expect(patch.section).toContain("--- a/OLD.md");
    expect(patch.section).toContain("+++ /dev/null");
    expect(patch.section).toContain("@@ -1 +0,0 @@");
    expect(patch.section).toContain("-gone");
  });

  it("keeps the carriage returns of a file with Windows line endings", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\r\ntwo\r\n", "one\r\ntwo again\r\n"),
    });

    expect(patch.section).toContain("-two\r");
    expect(patch.section).toContain("+two again\r");
  });

  it("keeps a file that only moved, which has no hunks to give", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "docs/new.md", oldPath: "docs/old.md", changeKind: "rename-pure" }),
      texts: texts("same\n", "same\n"),
    });

    expect(patch.truncated).toBe(false);
    expect(patch.section).toBe(
      [
        "diff --git a/docs/old.md b/docs/new.md",
        "rename from docs/old.md",
        "rename to docs/new.md",
        "--- a/docs/old.md",
        "+++ b/docs/new.md",
        "",
      ].join("\n"),
    );
  });

  it("reports a binary file as changed rather than spelling it out", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("PNG\u0000old", "PNG\u0000new"),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toContain("Binary files a/logo.png and b/logo.png differ");
  });

  it("takes the host's word that a file is binary, whatever its bytes look like", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("b2xk", "bmV3", true),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toContain("Binary files a/logo.png and b/logo.png differ");
  });

  it("counts an overlong file in bytes rather than in characters", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "notes.md", oldPath: "notes.md" }),
      texts: texts("\u4e00".repeat(200_000), "\u4e8c".repeat(200_000)),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", ""].join("\n"),
    );
  });

  it("lists a file too far apart to diff without its hunks", () => {
    const lines = (prefix: string) =>
      Array.from({ length: MAX_FILE_DIFF_EDITS }, (_, line) => `${prefix} ${line}`).join("\n");
    const patch = azureDevOpsFilePatch({
      change: change({ path: "generated.ts", oldPath: "generated.ts" }),
      texts: texts(`${lines("old")}\n`, `${lines("new")}\n`),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.abandoned).toBe(true);
    expect(patch.section).toBe(
      [
        "diff --git a/generated.ts b/generated.ts",
        "--- a/generated.ts",
        "+++ b/generated.ts",
        "",
      ].join("\n"),
    );
  });

  it("keeps a wholly new file too heavy to write out listed without its hunks", () => {
    const contents = `${Array.from({ length: 200_000 }, () => "x").join("\n")}\n`;
    const patch = azureDevOpsFilePatch({
      change: change({ path: "bundle.min.js", oldPath: "bundle.min.js", changeKind: "new" }),
      texts: texts("", contents),
    });

    expect(byteLength(contents)).toBeLessThan(512 * 1024);
    expect(patch.truncated).toBe(true);
    expect(patch.abandoned).toBe(false);
    expect(patch.edits).toBe(200_000);
    expect(patch.section).toBe(
      [
        "diff --git a/bundle.min.js b/bundle.min.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/bundle.min.js",
        "",
      ].join("\n"),
    );
  });

  it("gives an empty new file no hunk to read", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "EMPTY.md", oldPath: "EMPTY.md", changeKind: "new" }),
      texts: texts("", ""),
    });

    expect(patch.edits).toBe(0);
    expect(patch.section).not.toContain("@@");
  });

  it("marks a wholly new file whose last line has no newline after it", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "NOTES.md", oldPath: "NOTES.md", changeKind: "new" }),
      texts: texts("", "one\ntwo"),
    });

    expect(patch.section).toBe(
      [
        "diff --git a/NOTES.md b/NOTES.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/NOTES.md",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });
});

describe("a file Azure names something a patch header cannot carry plainly", () => {
  it("quotes the names a rename states, which carry no side letter", () => {
    const patch = azureDevOpsFilePatch({
      change: change({
        path: "docs/new\tname.md",
        oldPath: "docs/old\tname.md",
        changeKind: "rename-pure",
      }),
      texts: texts("same\n", "same\n"),
    });

    expect(patch.section).toBe(
      [
        'diff --git "a/docs/old\\tname.md" "b/docs/new\\tname.md"',
        'rename from "docs/old\\tname.md"',
        'rename to "docs/new\\tname.md"',
        '--- "a/docs/old\\tname.md"',
        '+++ "b/docs/new\\tname.md"',
        "",
      ].join("\n"),
    );
  });

  it("hands a reader of the header back the name Azure gave", () => {
    const path = 'every\t\n"kind"\\of.md';
    const patch = azureDevOpsFilePatch({
      change: change({ path, oldPath: path }),
      texts: texts("one\n", "two\n"),
    });
    const [header, oldLine, newLine] = patch.section.split("\n");

    expect(header).not.toContain("\t");
    expect(unquoteGitPatchPath(oldLine?.slice(4) ?? "")).toBe(`a/${path}`);
    expect(unquoteGitPatchPath(newLine?.slice(4) ?? "")).toBe(`b/${path}`);
  });
});

describe("a diff cursor", () => {
  it("reads anything it did not write as no position at all", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "abc",
      "1",
      "0:4",
      "1:-2",
      "1:2:3",
      "1:2:x",
      "1:2:d:1",
    ]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });

  it("names the source of the file list its position counts in", () => {
    expect(parseAzureDevOpsDiffCursor("3:12")).toEqual({
      iterationId: 3,
      fileIndex: 12,
      source: "changes",
    });
    expect(parseAzureDevOpsDiffCursor("3:12:d")).toEqual({
      iterationId: 3,
      fileIndex: 12,
      source: "filesdiff",
    });
    for (const source of ["changes", "filesdiff"] as const) {
      const cursor = { iterationId: 5, fileIndex: 0, source };
      expect(parseAzureDevOpsDiffCursor(formatAzureDevOpsDiffCursor(cursor))).toEqual(cursor);
    }
  });
});

/** The blocks Azure gives for text it split on "\n", which leaves a last line of "" after a newline. */
function block(
  kind: AzureDevOpsDiffBlock["kind"],
  oldStart: number,
  newStart: number,
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  counts: { readonly old?: number; readonly new?: number } = {},
): AzureDevOpsDiffBlock {
  return {
    kind,
    oldStart,
    newStart,
    oldLines,
    newLines,
    oldCount: counts.old ?? oldLines.length,
    newCount: counts.new ?? newLines.length,
  };
}

const unchanged = (
  oldStart: number,
  newStart: number,
  lines: ReadonlyArray<string>,
  count = lines.length,
) => block("none", oldStart, newStart, lines, lines, { old: count, new: count });

interface BlockRow {
  readonly name: string;
  readonly change?: Partial<AzureDevOpsChangeEntry>;
  readonly oldText: string;
  readonly newText: string;
  readonly blocks: ReadonlyArray<AzureDevOpsDiffBlock>;
  readonly hunks: ReadonlyArray<string>;
  readonly edits: number;
}

const NO_NEWLINE = "\\ No newline at end of file";

const blockRows: ReadonlyArray<BlockRow> = [
  {
    name: "an edit with its context",
    oldText: "one\ntwo\nthree\n",
    newText: "one\ntwo again\nthree\n",
    blocks: [
      unchanged(1, 1, ["one"]),
      block("edit", 2, 2, ["two"], ["two again"]),
      unchanged(3, 3, ["three", ""]),
    ],
    hunks: ["@@ -1,3 +1,3 @@", " one", "-two", "+two again", " three"],
    edits: 2,
  },
  {
    name: "a new file, which Azure numbers from 0",
    change: { path: "NEW.md", oldPath: "NEW.md", changeKind: "new" },
    oldText: "",
    newText: "a\nb\n",
    blocks: [block("add", 0, 1, [], ["a", "b", ""])],
    hunks: ["@@ -0,0 +1,2 @@", "+a", "+b"],
    edits: 2,
  },
  {
    name: "a deleted file, which Azure numbers from 0",
    change: { path: "OLD.md", oldPath: "OLD.md", changeKind: "deleted" },
    oldText: "gone\n",
    newText: "",
    blocks: [block("delete", 1, 0, ["gone", ""], [])],
    hunks: ["@@ -1 +0,0 @@", "-gone"],
    edits: 1,
  },
  {
    name: "a change a plain diff would slide past the line Azure keeps unchanged",
    oldText: "p\n}\n}\n{\nL\n",
    newText: "p\n}\n{\n{\nL\n",
    blocks: [
      unchanged(1, 1, ["p", "}"]),
      block("edit", 3, 3, ["}"], ["{"]),
      unchanged(4, 4, ["{", "L", ""]),
    ],
    hunks: ["@@ -1,5 +1,5 @@", " p", " }", "-}", "+{", " {", " L"],
    edits: 2,
  },
  {
    name: "two edits seven lines apart, which Azure writes with a gap between",
    oldText: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n",
    newText: "a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\n",
    blocks: [
      unchanged(1, 1, ["a"]),
      block("edit", 2, 2, ["b"], ["B"]),
      unchanged(3, 3, ["c", "d", "e"], 7),
      unchanged(7, 7, ["g", "h", "i"]),
      block("edit", 10, 10, ["j"], ["J"]),
      unchanged(11, 11, ["k", ""]),
    ],
    hunks: [
      "@@ -1,5 +1,5 @@",
      " a",
      "-b",
      "+B",
      " c",
      " d",
      " e",
      "@@ -7,5 +7,5 @@",
      " g",
      " h",
      " i",
      "-j",
      "+J",
      " k",
    ],
    edits: 4,
  },
  {
    name: "an empty line that ends a window is a line of the file, not its end",
    oldText: "a\nb\nc\n\nd\ne\nf\ng\nh\ni\n",
    newText: "A\nb\nc\n\nd\ne\nf\ng\nh\ni\n",
    blocks: [block("edit", 1, 1, ["a"], ["A"]), unchanged(2, 2, ["b", "c", ""], 9)],
    hunks: ["@@ -1,4 +1,4 @@", "-a", "+A", " b", " c", " "],
    edits: 2,
  },
  {
    name: "a last line edited in a file with no newline at its end",
    oldText: "a\nb",
    newText: "a\nc",
    blocks: [unchanged(1, 1, ["a"]), block("edit", 2, 2, ["b"], ["c"])],
    hunks: ["@@ -1,2 +1,2 @@", " a", "-b", NO_NEWLINE, "+c", NO_NEWLINE],
    edits: 2,
  },
  {
    name: "a newline added after the last line",
    oldText: "a\nb",
    newText: "a\nb\n",
    blocks: [unchanged(1, 1, ["a", "b"]), block("add", 3, 3, [], [""])],
    hunks: ["@@ -1,2 +1,2 @@", " a", "-b", NO_NEWLINE, "+b"],
    edits: 2,
  },
  {
    name: "the newline taken from after the last line",
    oldText: "a\nb\n",
    newText: "a\nb",
    blocks: [unchanged(1, 1, ["a", "b"]), block("delete", 3, 3, [""], [])],
    hunks: ["@@ -1,2 +1,2 @@", " a", "-b", "+b", NO_NEWLINE],
    edits: 2,
  },
  {
    name: "a line appended to a file that had no newline",
    oldText: "a",
    newText: "a\nb\n",
    blocks: [unchanged(1, 1, ["a"]), block("edit", 2, 2, [], ["b", ""])],
    hunks: ["@@ -1 +1,2 @@", "-a", NO_NEWLINE, "+a", "+b"],
    edits: 3,
  },
  {
    name: "a last window that counts the newline the new side gained, which no line shows",
    oldText: "a\nb",
    newText: "A\nb\n",
    blocks: [
      block("edit", 1, 1, ["a"], ["A"]),
      block("none", 2, 2, ["b"], ["b"], { old: 1, new: 2 }),
    ],
    hunks: ["@@ -1,2 +1,2 @@", "-a", "-b", NO_NEWLINE, "+A", "+b"],
    edits: 4,
  },
  {
    name: "a new file with no newline at its end",
    change: { path: "NEW.md", oldPath: "NEW.md", changeKind: "new" },
    oldText: "",
    newText: "x\ny",
    blocks: [block("add", 0, 1, [], ["x", "y"])],
    hunks: ["@@ -0,0 +1,2 @@", "+x", "+y", NO_NEWLINE],
    edits: 2,
  },
];

describe("azureDevOpsFileDiffPatch", () => {
  it.each(blockRows)("writes $name as the unified patch", (row) => {
    const patch = azureDevOpsFileDiffPatch({
      change: change(row.change),
      blocks: row.blocks,
    });

    expect(patch).not.toBeNull();
    expect(patch?.truncated).toBe(false);
    expect(patch?.edits).toBe(row.edits);
    const section = patch?.section ?? "";
    expect(section.slice(section.indexOf("@@"))).toBe(`${row.hunks.join("\n")}\n`);
    // The hunks must say what the files say, whatever they look like.
    expect(applyPatch(row.oldText, section.slice(section.indexOf("--- ")))).toBe(row.newText);
  });

  it("keeps a file that only moved, which lists no blocks", () => {
    const patch = azureDevOpsFileDiffPatch({
      change: change({ path: "docs/new.md", oldPath: "docs/old.md", changeKind: "rename-pure" }),
      blocks: [],
    });

    expect(patch?.truncated).toBe(false);
    expect(patch?.section).toContain("rename from docs/old.md");
    expect(patch?.section).not.toContain("@@");
  });

  it.each([
    ["blocks it could not read", null],
    ["no blocks for a file that did not just move", []],
    [
      "a window whose two sides differ in length",
      [block("none", 1, 1, ["a", "b"], ["a"], { old: 2, new: 1 })],
    ],
    [
      "an edit whose lines are not the count it states",
      [block("edit", 1, 1, ["a"], ["b"], { old: 2 })],
    ],
    [
      "blocks that run backwards",
      [block("edit", 5, 5, ["a"], ["b"]), block("edit", 2, 2, ["c"], ["d"])],
    ],
    ["blocks that change nothing", [unchanged(1, 1, ["same", ""])]],
    [
      "blocks whose only change is indentation, which Azure takes for equal",
      [block("none", 1, 1, ["    keep", ""], ["keep", ""])],
    ],
    [
      "an edit with less context than a diff gives, before text Azure elided",
      [block("edit", 1, 1, ["a"], ["A"]), unchanged(2, 2, ["b"], 9), unchanged(8, 8, ["h", ""])],
    ],
    [
      "an edit with less context than a diff gives, before the end of a file Azure elided",
      [block("edit", 1, 1, ["a"], ["A"]), unchanged(2, 2, ["b"], 9)],
    ],
    [
      "a last window that hides more lines on one side, whose newline change no line shows",
      [
        block("edit", 1, 1, ["a"], ["A"]),
        block("none", 2, 2, ["b", "c", "d"], ["b", "c", "d"], { old: 5, new: 6 }),
      ],
    ],
    [
      "a line further down than a file may be long",
      [block("edit", 2_000_000, 2_000_000, ["a"], ["b"])],
    ],
    [
      "a line holding one of the tags a rebuilt side marks its lines with",
      [block("edit", 1, 1, ["a\u0002"], ["a\u0003"])],
    ],
  ] as const)("leaves %s for the caller to read", (_name, blocks) => {
    expect(azureDevOpsFileDiffPatch({ change: change(), blocks })).toBeNull();
  });

  it("lists a file too long to write out without its hunks, as the diff of its contents does", () => {
    const lines = Array.from({ length: 1_000 }, (_, line) => `${line} ${"z".repeat(600)}`);
    const patch = azureDevOpsFileDiffPatch({
      change: change({ path: "big.txt", oldPath: "big.txt", changeKind: "new" }),
      blocks: [block("add", 0, 1, [], [...lines, ""])],
    });

    expect(patch?.truncated).toBe(true);
    expect(patch?.section).not.toContain("@@");
  });
});

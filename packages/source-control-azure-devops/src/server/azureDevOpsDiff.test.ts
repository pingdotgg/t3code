import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { describe, expect, it } from "vite-plus/test";

import {
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  byteLength,
  formatAzureDevOpsDiffCursor,
  MAX_FILE_DIFF_EDITS,
  parseAzureDevOpsDiffCursor,
} from "./azureDevOpsDiff.ts";
import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

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

  it("names the side a new file does not have as /dev/null", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "DEMO.md", oldPath: "DEMO.md", changeKind: "new" }),
      texts: texts("", "hello\n"),
    });

    expect(patch.section).toContain("new file mode 100644");
    expect(patch.section).toContain("--- /dev/null");
    expect(patch.section).toContain("+++ b/DEMO.md");
    expect(patch.section).toContain("@@ -0,0 +1 @@");
    expect(patch.section).toContain("+hello");
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

  it("shows an overlong file as changed without its hunks", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "bundle.js", oldPath: "bundle.js" }),
      texts: texts("a\n".repeat(400_000), "b\n".repeat(400_000)),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/bundle.js b/bundle.js", "--- a/bundle.js", "+++ b/bundle.js", ""].join("\n"),
    );
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

  const lineRange = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, line) => `${prefix} ${line}`).join("\n");

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

  it("writes out a wholly new file however many lines it has", () => {
    const contents = `${Array.from({ length: 15_000 }, () => "x".repeat(29)).join("\n")}\n`;
    const patch = azureDevOpsFilePatch({
      change: change({ path: "DEMO.md", oldPath: "DEMO.md", changeKind: "new" }),
      texts: texts("", contents),
    });

    expect(byteLength(contents)).toBeLessThan(512 * 1024);
    expect(patch.truncated).toBe(false);
    expect(patch.abandoned).toBe(false);
    expect(patch.edits).toBe(15_000);
    expect(patch.section).toContain("@@ -0,0 +1,15000 @@");
    expect(patch.section.match(/^\+/gmu)).toHaveLength(15_001);
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

  it("writes out a wholly deleted file however many lines it had", () => {
    const contents = `${lineRange(20_000, "line")}\n`;
    const patch = azureDevOpsFilePatch({
      change: change({ path: "OLD.md", oldPath: "OLD.md", changeKind: "deleted" }),
      texts: texts(contents, ""),
    });

    expect(patch.truncated).toBe(false);
    expect(patch.abandoned).toBe(false);
    expect(patch.edits).toBe(20_000);
    expect(patch.section).toContain("@@ -1,20000 +0,0 @@");
    expect(patch.section.match(/^-line /gmu)).toHaveLength(20_000);
    expect(patch.section.match(/^-/gmu)).toHaveLength(20_001);
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

  it("keeps a file it did diff out of the giving up", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\ntwo\n", "one\ntwo again\n"),
    });

    expect(patch.abandoned).toBe(false);
  });

  it("counts what the diff worked out, which is what the file cost to diff", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\ntwo\nthree\nfour\n", "one\ntwo again\nthree\nfour\n"),
    });

    expect(patch.edits).toBe(2);
  });

  it("counts nothing for a file it never diffed", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("PNG\u0000old", "PNG\u0000new"),
    });

    expect(patch.edits).toBe(0);
  });

  it("lists a file whose hunks outweigh its sides without them", () => {
    const line = `${"a".repeat(400 * 1024)}\n`;
    const patch = azureDevOpsFilePatch({
      change: change({ path: "min.js", oldPath: "min.js" }),
      texts: texts(line, `${"b".repeat(400 * 1024)}\n`),
    });

    expect(patch.edits).toBeLessThan(MAX_FILE_DIFF_EDITS);
    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/min.js b/min.js", "--- a/min.js", "+++ b/min.js", ""].join("\n"),
    );
    expect(byteLength(patch.section)).toBeLessThan(byteLength(line));
  });

  it("marks a file that does not end in a newline, as git does", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\n", "two"),
    });

    expect(patch.section).toContain("\\ No newline at end of file");
  });
});

describe("azureDevOpsUnreadableFilePatch", () => {
  it("keeps a file the host would not hand over, listed without its hunks", () => {
    const patch = azureDevOpsUnreadableFilePatch(change({ path: "huge.bin", oldPath: "huge.bin" }));

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/huge.bin b/huge.bin", "--- a/huge.bin", "+++ b/huge.bin", ""].join("\n"),
    );
  });
});

describe("a file Azure names something a patch header cannot carry plainly", () => {
  it("writes each side as git's quoted form, the side letter inside the quotes", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "notes\treadme.md", oldPath: "notes\treadme.md" }),
      texts: texts("one\n", "two\n"),
    });

    expect(patch.section).toBe(
      [
        'diff --git "a/notes\\treadme.md" "b/notes\\treadme.md"',
        '--- "a/notes\\treadme.md"',
        '+++ "b/notes\\treadme.md"',
        "@@ -1 +1 @@",
        "-one",
        "+two",
        "",
      ].join("\n"),
    );
  });

  it("keeps a name holding a newline on the one header line it belongs to", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "line\nfile.txt", oldPath: "line\nfile.txt" }),
      texts: texts("one\n", "two\n"),
    });

    expect(patch.section.split("\n").slice(0, 3)).toEqual([
      'diff --git "a/line\\nfile.txt" "b/line\\nfile.txt"',
      '--- "a/line\\nfile.txt"',
      '+++ "b/line\\nfile.txt"',
    ]);
  });

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

  it("quotes the sides of the one line a binary file gets", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo\tmark.png", oldPath: "logo\tmark.png" }),
      texts: texts("PNG\u0000old", "PNG\u0000new"),
    });

    expect(patch.section).toContain(
      'Binary files "a/logo\\tmark.png" and "b/logo\\tmark.png" differ',
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
  it("carries the push it was taken against back to the next slice", () => {
    const cursor = formatAzureDevOpsDiffCursor({ iterationId: 3, fileIndex: 12 });

    expect(parseAzureDevOpsDiffCursor(cursor)).toEqual({ iterationId: 3, fileIndex: 12 });
  });

  it("reads anything it did not write as no position at all", () => {
    for (const raw of [undefined, null, "", "abc", "1", "0:4", "1:-2", "1:2:3"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });

  it("refuses a half it did not write rather than reading it as the first file", () => {
    for (const raw of ["1:", ":4", "1: ", " 1:4", "1:0x2", "0x1:2", "1e2:0", "1:4.0"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });
});

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
    // Git points the range a new file does not have at line zero, not at line one.
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
    // They are part of the line rather than around it, so a patch that dropped them would ask
    // the reader to look at a change that is not the one on the host.
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
    // Azure hands such a file over base64-encoded, so nothing in the text it sent gives it away.
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("b2xk", "bmV3", true),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toContain("Binary files a/logo.png and b/logo.png differ");
  });

  it("counts an overlong file in bytes rather than in characters", () => {
    // Three bytes each, so a ceiling counted in code units would let three times the size through.
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
    // Sharing no line at all costs one edit per line on each side, so this pair is twice the
    // ceiling apart. Left to itself the search costs about the square of that and would hold the
    // whole server, every websocket client with it, while it worked out a patch nobody reads.
    // Writing both sides out instead would read as a genuine rewrite: the ceiling is a distance
    // rather than a proportion, so a long file reaches it having changed in one corner, and that
    // corner would be buried in a wall of red and green.
    const lines = (prefix: string) =>
      Array.from({ length: MAX_FILE_DIFF_EDITS }, (_, line) => `${prefix} ${line}`).join("\n");
    const patch = azureDevOpsFilePatch({
      change: change({ path: "generated.ts", oldPath: "generated.ts" }),
      texts: texts(`${lines("old")}\n`, `${lines("new")}\n`),
    });

    expect(patch.truncated).toBe(true);
    // And it says the search was given up on, because the reader of a run of files is meant to
    // stop rather than spend that work again on each of the ones behind it.
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
    // Nothing on the old side means there was no edit distance to search out, so this is the
    // minimal patch and not a stand-in for one. Fifteen thousand lines of thirty bytes is the
    // shape this used to lose: inside the byte ceiling that gates every file, and well past every
    // bound a two-sided file answers to, none of which is protecting against anything here.
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
    // Only the `+++` of the header on top of the file's own lines, so nothing was dropped out of
    // the middle.
    expect(patch.section.match(/^\+/gmu)).toHaveLength(15_001);
  });

  it("keeps a wholly new file too heavy to write out listed without its hunks", () => {
    // Every line carries a marker, so a side of very short lines answers with up to twice its own
    // bytes: these 200,000 one-character lines fit the ceiling each side is read under and weigh
    // about 600KB written out, more than twice what a whole slice may carry. There is no smaller
    // true patch for a creation to fall back to, so it is listed without its hunks, the same as a
    // side too big to read at all, rather than sent at a size the slice budget exists to prevent.
    const contents = `${Array.from({ length: 200_000 }, () => "x").join("\n")}\n`;
    const patch = azureDevOpsFilePatch({
      change: change({ path: "bundle.min.js", oldPath: "bundle.min.js", changeKind: "new" }),
      texts: texts("", contents),
    });

    expect(byteLength(contents)).toBeLessThan(512 * 1024);
    expect(patch.truncated).toBe(true);
    expect(patch.abandoned).toBe(false);
    // It still cost the walk over its lines, which is what the slice is charged for.
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
    // A file with nothing on either side has no lines to claim were replaced, and git writes it
    // as a header alone.
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
    // The caller spends a budget of these across a slice, so they have to be the edits the search
    // actually made: one line replaced is a removal and an addition, and the three lines of
    // context around them cost nothing.
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
    // A handful of very long lines is a few edits and nowhere near the edit ceiling, and the
    // patch carries both sides in full with three lines of context around each hunk, so the
    // section comes out heavier than either side was. What one file weighs is what a slice's
    // budget is spent in, so the edit ceiling alone does not bound this.
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

describe("a diff cursor", () => {
  it("carries the push it was taken against back to the next slice", () => {
    const cursor = formatAzureDevOpsDiffCursor({ iterationId: 3, fileIndex: 12 });

    expect(parseAzureDevOpsDiffCursor(cursor)).toEqual({ iterationId: 3, fileIndex: 12 });
  });

  it("reads anything it did not write as no position at all", () => {
    // Which starts the read from the top rather than failing it: a cursor is the client's to
    // hand back, and nothing downstream is worth refusing a whole diff over.
    for (const raw of [undefined, null, "", "abc", "1", "0:4", "1:-2", "1:2:3"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });

  it("refuses a half it did not write rather than reading it as the first file", () => {
    // `Number` is wider than the cursor: an empty, padded or hex half would otherwise pass as a
    // position, and the read would resume against an iteration the client never saw instead of
    // starting again from the latest one.
    for (const raw of ["1:", ":4", "1: ", " 1:4", "1:0x2", "0x1:2", "1e2:0", "1:4.0"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });
});

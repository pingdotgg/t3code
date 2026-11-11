import { assert, describe, it } from "@effect/vitest";

import { parseDiffFilePaths, parseDiffFileRevisions } from "./diffFileRevisions.ts";

function patchOf(...lines: ReadonlyArray<string>): string {
  return `${lines.join("\n")}\n`;
}

describe("parseDiffFileRevisions", () => {
  it("reads the head id of a changed file off its index line", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/src/a.ts b/src/a.ts",
        "index 7f2aa0ab6..b4a2a7c9a 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    assert.deepStrictEqual([...revisions], [["src/a.ts", "b4a2a7c9a"]]);
  });

  it("names a deletion by the path it had, which is the one still on screen", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-x",
      ),
    );

    assert.deepStrictEqual([...revisions], [["gone.ts", "0000000"]]);
  });

  it("names a rename by where it moved to", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "index 2222222..3333333 100644",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    assert.deepStrictEqual([...revisions], [["new.ts", "3333333"]]);
  });

  it("names a rename that changed nothing, which states no paths of its own", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/old.ts b/new.ts",
        "similarity index 100%",
        "rename from old.ts",
        "rename to new.ts",
        "index 2222222..2222222 100644",
      ),
    );

    assert.deepStrictEqual([...revisions], [["new.ts", "2222222"]]);
  });

  it("keeps a leading U+FEFF in a quoted rename's revision key", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        'diff --git a/old.txt "b/\\357\\273\\277note.txt"',
        "similarity index 100%",
        "rename from old.txt",
        'rename to "\\357\\273\\277note.txt"',
        "index 2222222..2222222 100644",
      ),
    );

    assert.deepStrictEqual([...revisions], [["\uFEFFnote.txt", "2222222"]]);
  });

  it("leaves out a file Bitbucket excluded, which it gives no index line for", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/package.json b/package.json",
        "index 7f2aa0ab6..b4a2a7c9a 100644",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1 +1 @@",
        '-  "x": "1"',
        '+  "x": "2"',
        "diff --git a/yarn.lock b/yarn.lock",
        'File excluded by pattern "yarn.lock"',
      ),
    );

    assert.deepStrictEqual([...revisions], [["package.json", "b4a2a7c9a"]]);
  });

  it("stops reading headers at the first hunk, so content cannot pose as one", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/notes.md b/notes.md",
        "index aaaaaaa..bbbbbbb 100644",
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1,2 +1,2 @@",
        "--- a/decoy.ts",
        "+++ b/decoy.ts",
        "+index ccccccc..ddddddd 100644",
      ),
    );

    assert.deepStrictEqual([...revisions], [["notes.md", "bbbbbbb"]]);
  });

  it("splits a header whose paths contain the separator, by the sides agreeing", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/one b/two.ts b/one b/two.ts",
        "index eeeeeee..fffffff 100644",
        "@@ -1 +1 @@",
      ),
    );

    assert.deepStrictEqual([...revisions], [["one b/two.ts", "fffffff"]]);
  });

  it("reads a name git had to quote, here one holding a tab", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        'diff --git "a/we\\tird.ts" "b/we\\tird.ts"',
        "index 4444444..5555555 100644",
        '--- "a/we\\tird.ts"',
        '+++ "b/we\\tird.ts"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    assert.deepStrictEqual([...revisions], [["we\tird.ts", "5555555"]]);
  });

  it("rejoins the octal bytes git writes for a name outside ASCII", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        'diff --git "a/caf\\303\\251/r\\303\\251sum\\303\\251.ts" "b/caf\\303\\251/r\\303\\251sum\\303\\251.ts"',
        "index 6666666..7777777 100644",
        "@@ -1 +1 @@",
      ),
    );

    assert.deepStrictEqual([...revisions], [["café/résumé.ts", "7777777"]]);
  });

  it("splits a rename header where git quoted only the side that needed it", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        'diff --git a/old.ts "b/new\\tname.ts"',
        "similarity index 90%",
        "rename from old.ts",
        'rename to "new\\tname.ts"',
        "index 8888888..9999999 100644",
        "--- a/old.ts",
        '+++ "b/new\\tname.ts"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    assert.deepStrictEqual([...revisions], [["new\tname.ts", "9999999"]]);
  });

  it("keeps a character from outside the basic plane that git left unescaped", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        'diff --git "a/we\\tird-\u{1f680}.ts" "b/we\\tird-\u{1f680}.ts"',
        "index aaaaaaa..bbbbbbb 100644",
        "@@ -1 +1 @@",
      ),
    );

    assert.deepStrictEqual([...revisions], [["we\tird-\u{1f680}.ts", "bbbbbbb"]]);
  });

  it("drops the tab git ends a name holding a space with", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/with space.txt b/with space.txt",
        "index 1111111..6178079 100644",
        "--- a/with space.txt\t",
        "+++ b/with space.txt\t",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    assert.deepStrictEqual([...revisions], [["with space.txt", "6178079"]]);
  });

  it("drops the timestamp other producers of the format write past that tab", () => {
    const revisions = parseDiffFileRevisions(
      patchOf(
        "diff --git a/stamped.ts b/stamped.ts",
        "index 4444444..5555555 100644",
        "--- a/stamped.ts\t2024-01-01 00:00:00.000000000 +0000",
        "+++ b/stamped.ts\t2024-01-02 00:00:00.000000000 +0000",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    assert.deepStrictEqual([...revisions], [["stamped.ts", "5555555"]]);
  });
});

describe("parseDiffFilePaths", () => {
  it("names both sides of each file, with no side for an added or deleted one", () => {
    const paths = parseDiffFilePaths(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "--- a/not/a/header.ts",
        "diff --git a/added.md b/added.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.md",
        "diff --git a/gone.md b/gone.md",
        "deleted file mode 100644",
        "--- a/gone.md",
        "+++ /dev/null",
        'diff --git "a/tab\\tname" b/moved.ts',
        'rename from "tab\\tname"',
        "rename to moved.ts",
        "",
      ].join("\n"),
    );

    assert.deepStrictEqual(paths, [
      { oldPath: "src/a.ts", newPath: "src/a.ts" },
      { oldPath: null, newPath: "added.md" },
      { oldPath: "gone.md", newPath: null },
      { oldPath: "tab\tname", newPath: "moved.ts" },
    ]);
  });
});

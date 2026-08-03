import { describe, expect, it } from "vite-plus/test";
import {
  buildHunkPatch,
  hasStageableHunks,
  isNewFileDiff,
  parseFileDiff,
  type DiffHunk,
} from "./diffPatch";

/** The nth hunk of a fixture; fails loudly rather than asserting on undefined. */
function hunkAt(raw: string, index: number): DiffHunk {
  const hunk = parseFileDiff(raw)?.hunks[index];
  expect(hunk).toBeDefined();
  return hunk as DiffHunk;
}

// diffPatch synthesizes the single-hunk patches fed to `git apply --recount`.
// A wrong `@@` header or a dropped body line silently corrupts the working
// tree, so these fixtures mirror real `git diff` output byte for byte.

const TWO_HUNKS = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..89abcde 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 const a = 1
-const b = 2
+const b = 22
 const c = 3
 const d = 4
@@ -20,2 +20,3 @@ function tail() {
   return 1
+  // added
 }
`;

const PURE_ADDITION = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

const PURE_DELETION = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`;

const NO_NEWLINE = `diff --git a/eof.txt b/eof.txt
--- a/eof.txt
+++ b/eof.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

const RENAME_WITH_CONTENT = `diff --git a/old/path.ts b/new/path.ts
similarity index 88%
rename from old/path.ts
rename to new/path.ts
--- a/old/path.ts
+++ b/new/path.ts
@@ -1,2 +1,2 @@
 keep
-was
+now
`;

// The regression this parser exists for: a *deleted line whose text starts
// with* `--- ` / `+++ ` / `diff --git `. Reading those as file headers drops
// them from the body and produces a patch that corrupts the file.
const HEADER_LOOKALIKE_BODY = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,5 +1,4 @@
 intro
---- old rule
-+++ old rule
-diff --git a/x b/y
+--- new rule
++++ new rule
 outro
`;

const BINARY = `diff --git a/img.png b/img.png
index 1234567..89abcde 100644
Binary files a/img.png and b/img.png differ
`;

const MODE_ONLY = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

describe("parseFileDiff", () => {
  it("extracts paths and every hunk", () => {
    const parsed = parseFileDiff(TWO_HUNKS);
    expect(parsed?.oldPath).toBe("src/foo.ts");
    expect(parsed?.newPath).toBe("src/foo.ts");
    expect(parsed?.hunks).toHaveLength(2);
  });

  it("reads start lines from the header and counts +/- excluding context", () => {
    const first = hunkAt(TWO_HUNKS, 0);
    const second = hunkAt(TWO_HUNKS, 1);
    expect(first.oldStart).toBe(1);
    expect(first.newStart).toBe(1);
    expect(first.additions).toBe(1);
    expect(first.deletions).toBe(1);
    expect(second.oldStart).toBe(20);
    expect(second.additions).toBe(1);
    expect(second.deletions).toBe(0);
  });

  it("keeps body lines verbatim, with their +/-/space prefix", () => {
    const first = hunkAt(TWO_HUNKS, 0);
    expect(first.body).toEqual([
      " const a = 1",
      "-const b = 2",
      "+const b = 22",
      " const c = 3",
      " const d = 4",
    ]);
  });

  // The header's declared counts bound the body, so the trailing empty string
  // produced by `raw.split("\n")` is not absorbed as a phantom context line.
  it("does not append a phantom context line to the final hunk", () => {
    const second = hunkAt(TWO_HUNKS, 1);
    expect(second.body).toEqual(["   return 1", "+  // added", " }"]);
  });

  it("does not leak the next hunk into the previous one", () => {
    const first = hunkAt(TWO_HUNKS, 0);
    expect(first.body.some((line) => line.includes("added"))).toBe(false);
  });

  it("preserves the header verbatim, including the trailing function context", () => {
    const second = hunkAt(TWO_HUNKS, 1);
    expect(second.header).toBe("@@ -20,2 +20,3 @@ function tail() {");
  });

  it("handles a /dev/null old side (new file)", () => {
    const parsed = parseFileDiff(PURE_ADDITION);
    expect(parsed?.newPath).toBe("new.txt");
    expect(parsed?.hunks[0]!.deletions).toBe(0);
    expect(parsed?.hunks[0]!.additions).toBe(2);
  });

  it("handles a /dev/null new side (deleted file)", () => {
    const parsed = parseFileDiff(PURE_DELETION);
    expect(parsed?.oldPath).toBe("gone.txt");
    expect(parsed?.hunks[0]!.additions).toBe(0);
    expect(parsed?.hunks[0]!.deletions).toBe(2);
  });

  it('keeps "\\ No newline at end of file" markers in the body', () => {
    const hunk = hunkAt(NO_NEWLINE, 0);
    expect(hunk.body.filter((line) => line.startsWith("\\"))).toHaveLength(2);
  });

  it("does not count no-newline markers as additions or deletions", () => {
    const hunk = hunkAt(NO_NEWLINE, 0);
    expect(hunk.additions).toBe(1);
    expect(hunk.deletions).toBe(1);
  });

  it("uses the rename destination for newPath", () => {
    const parsed = parseFileDiff(RENAME_WITH_CONTENT);
    expect(parsed?.oldPath).toBe("old/path.ts");
    expect(parsed?.newPath).toBe("new/path.ts");
  });

  // REGRESSION: body lines that look like file headers must stay in the body.
  it("keeps deleted lines that look like ---/+++/diff --git headers", () => {
    const hunk = hunkAt(HEADER_LOOKALIKE_BODY, 0);
    expect(hunk.body).toEqual([
      " intro",
      "---- old rule",
      "-+++ old rule",
      "-diff --git a/x b/y",
      "+--- new rule",
      "++++ new rule",
      " outro",
    ]);
  });

  it("does not let a header-shaped body line overwrite the parsed paths", () => {
    const parsed = parseFileDiff(HEADER_LOOKALIKE_BODY);
    expect(parsed?.oldPath).toBe("doc.md");
    expect(parsed?.newPath).toBe("doc.md");
  });

  it("counts header-lookalike body lines correctly", () => {
    const hunk = hunkAt(HEADER_LOOKALIKE_BODY, 0);
    expect(hunk.deletions).toBe(3);
    expect(hunk.additions).toBe(2);
  });

  it("treats an omitted header count as 1", () => {
    const parsed = parseFileDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3 +3 @@\n-one\n+two\n");
    // `@@ -3 +3 @@` declares one line on each side; both are consumed.
    expect(parsed?.hunks[0]!.body).toEqual(["-one", "+two"]);
  });

  it("returns null for a binary diff", () => {
    expect(parseFileDiff(BINARY)).toBeNull();
  });

  it("returns null for a mode-only diff", () => {
    expect(parseFileDiff(MODE_ONLY)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseFileDiff("")).toBeNull();
  });

  it("ignores a malformed @@ line", () => {
    expect(parseFileDiff("diff --git a/f b/f\n@@ nonsense @@\n context\n")).toBeNull();
  });

  it("stops consuming a truncated hunk whose body ends early", () => {
    // Header promises 5 old lines but only 2 are present (no trailing newline).
    const parsed = parseFileDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,5 +1,5 @@\n one\n two",
    );
    expect(parsed?.hunks[0]!.body).toEqual([" one", " two"]);
  });

  it("ends a hunk at the next file section in a multi-file diff", () => {
    const parsed = parseFileDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +0,0 @@\n-a\n" +
        "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1,1 +0,0 @@\n-b\n",
    );
    expect(parsed?.hunks).toHaveLength(2);
    expect(parsed?.hunks[0]!.body).toEqual(["-a"]);
    expect(parsed?.hunks[1]!.body).toEqual(["-b"]);
  });
});

describe("buildHunkPatch", () => {
  it("emits a well-formed single-hunk patch ending in a newline", () => {
    const first = hunkAt(TWO_HUNKS, 0);
    expect(buildHunkPatch("src/foo.ts", first)).toBe(
      [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,4 +1,4 @@",
        " const a = 1",
        "-const b = 2",
        "+const b = 22",
        " const c = 3",
        " const d = 4",
        "",
      ].join("\n"),
    );
  });

  it("recomputes counts from the body rather than trusting the source header", () => {
    // Source header over-declares (`-1,99 +1,99`); the emitted header must
    // describe the body actually re-emitted, or `git apply` rejects the patch.
    const hunk = hunkAt(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,99 +1,99 @@\n ctx\n-old\n+new",
      0,
    );
    expect(buildHunkPatch("f", hunk)).toContain("@@ -1,2 +1,2 @@");
  });

  it("uses start 0 on a side that spans no lines (pure addition)", () => {
    const hunk = hunkAt(PURE_ADDITION, 0);
    expect(buildHunkPatch("new.txt", hunk)).toContain("@@ -0,0 +1,2 @@");
  });

  it("uses start 0 on a side that spans no lines (pure deletion)", () => {
    const hunk = hunkAt(PURE_DELETION, 0);
    expect(buildHunkPatch("gone.txt", hunk)).toContain("@@ -1,2 +0,0 @@");
  });

  it("excludes no-newline markers from the header counts but keeps them in the body", () => {
    const hunk = hunkAt(NO_NEWLINE, 0);
    const patch = buildHunkPatch("eof.txt", hunk);
    expect(patch).toContain("@@ -1,2 +1,2 @@");
    expect(patch).toContain("\\ No newline at end of file");
  });

  it("addresses a renamed file by its NEW path on both sides", () => {
    // `git apply --cached` resolves against the index by the b/ side, so a
    // content hunk for a renamed file must use the destination name.
    const hunk = hunkAt(RENAME_WITH_CONTENT, 0);
    const patch = buildHunkPatch("new/path.ts", hunk);
    expect(patch).toContain("diff --git a/new/path.ts b/new/path.ts");
    expect(patch).toContain("--- a/new/path.ts");
    expect(patch).toContain("+++ b/new/path.ts");
    expect(patch).not.toContain("old/path.ts");
  });

  it("round-trips a header-lookalike body without losing lines", () => {
    const hunk = hunkAt(HEADER_LOOKALIKE_BODY, 0);
    const patch = buildHunkPatch("doc.md", hunk);
    // 4 patch-header lines + 7 body lines + trailing newline.
    expect(patch.split("\n")).toHaveLength(12);
    expect(patch).toContain("@@ -1,5 +1,4 @@");
    expect(patch).toContain("\n-diff --git a/x b/y\n");
  });

  it("always terminates in exactly one trailing newline", () => {
    for (const raw of [TWO_HUNKS, PURE_ADDITION, PURE_DELETION, NO_NEWLINE]) {
      const hunk = hunkAt(raw, 0);
      const patch = buildHunkPatch("f", hunk);
      expect(patch.endsWith("\n")).toBe(true);
      expect(patch.endsWith("\n\n")).toBe(false);
    }
  });

  it("re-parses its own output to the same hunk (round-trip stability)", () => {
    const first = hunkAt(TWO_HUNKS, 0);
    const reparsed = parseFileDiff(buildHunkPatch("src/foo.ts", first));
    expect(reparsed?.hunks).toHaveLength(1);
    expect(reparsed?.hunks[0]!.body).toEqual(first.body);
    expect(reparsed?.hunks[0]!.additions).toBe(first.additions);
    expect(reparsed?.hunks[0]!.deletions).toBe(first.deletions);
  });

  it("round-trips the no-newline and header-lookalike fixtures too", () => {
    for (const [path, raw] of [
      ["eof.txt", NO_NEWLINE],
      ["doc.md", HEADER_LOOKALIKE_BODY],
      ["new/path.ts", RENAME_WITH_CONTENT],
    ] as const) {
      const hunk = hunkAt(raw, 0);
      const reparsed = parseFileDiff(buildHunkPatch(path, hunk));
      expect(reparsed?.hunks[0]!.body).toEqual(hunk.body);
    }
  });

  it("emits a header the body agrees with, on every fixture", () => {
    for (const raw of [
      TWO_HUNKS,
      PURE_ADDITION,
      PURE_DELETION,
      NO_NEWLINE,
      HEADER_LOOKALIKE_BODY,
    ]) {
      for (const hunk of parseFileDiff(raw)?.hunks ?? []) {
        const patch = buildHunkPatch("f", hunk);
        const header = patch.split("\n")[3] ?? "";
        const match = header.match(/^@@ -\d+,(\d+) \+\d+,(\d+) @@$/);
        expect(match).not.toBeNull();
        const bodyLines = hunk.body.filter((line) => !line.startsWith("\\"));
        const oldCount = bodyLines.filter((line) => line[0] !== "+").length;
        const newCount = bodyLines.filter((line) => line[0] !== "-").length;
        expect(Number(match?.[1])).toBe(oldCount);
        expect(Number(match?.[2])).toBe(newCount);
      }
    }
  });

  it("preserves an empty context line as a single space", () => {
    const parsed = parseFileDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n",
    );
    expect(parsed?.hunks[0]!.body).toContain(" ");
  });
});

describe("hasStageableHunks", () => {
  it.each([
    ["text diff", TWO_HUNKS, true],
    ["new file", PURE_ADDITION, true],
    ["deleted file", PURE_DELETION, true],
    ["rename with content", RENAME_WITH_CONTENT, true],
    ["binary", BINARY, false],
    ["mode only", MODE_ONLY, false],
    ["empty", "", false],
  ])("%s → %s", (_label, raw, expected) => {
    expect(hasStageableHunks(raw)).toBe(expected);
  });
});

// fork: f4 — an untracked file's synthesized patch has no index side, so its
// hunks can never be `git apply --cached`-ed.
describe("isNewFileDiff", () => {
  it("recognizes the /dev/null old side of a synthesized untracked patch", () => {
    expect(
      isNewFileDiff(
        [
          "diff --git a/dev/null b/fresh.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/fresh.ts",
          "@@ -0,0 +1 @@",
          "+one",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("leaves an ordinary modification alone", () => {
    expect(
      isNewFileDiff(
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1,2 @@",
          " one",
          "+two",
          "",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("does not mistake a deleted body line that reads like a header", () => {
    expect(isNewFileDiff(["@@ -1,2 +1 @@", " x", "--- /dev/nullish"].join("\n"))).toBe(false);
  });
});

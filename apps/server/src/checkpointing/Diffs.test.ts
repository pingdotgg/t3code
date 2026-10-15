import { describe, expect, it } from "vite-plus/test";

import { parseTurnDiffFilesFromNumstat, prefixNumstatPaths, prefixPatchPaths } from "./Diffs.ts";

describe("parseTurnDiffFilesFromNumstat", () => {
  it("returns an empty list when no files changed", () => {
    expect(parseTurnDiffFilesFromNumstat("")).toEqual([]);
  });

  it("sorts files and preserves addition and deletion counts", () => {
    const numstat = ["0\t2\tsrc/b.ts", "2\t1\ta.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("preserves both paths for renames and copies", () => {
    const numstat = [
      "0\t0\t",
      "src/old.ts",
      "src/new.ts",
      "2\t1\t",
      "src/source.ts",
      "src/copied.ts",
      "1\t0\tother.ts",
      "",
    ].join("\0");

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "other.ts", additions: 1, deletions: 0 },
      { path: "src/copied.ts", previousPath: "src/source.ts", additions: 2, deletions: 1 },
      { path: "src/new.ts", previousPath: "src/old.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("keeps binary files and empty files with zero line changes", () => {
    const numstat = ["-\t-\timage.png", "0\t0\tempty.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "empty.txt", additions: 0, deletions: 0 },
      { path: "image.png", additions: 0, deletions: 0 },
    ]);
  });

  it("preserves Unicode, tabs, line endings, and spaces in paths", () => {
    const path = " café\tline\r\nname.txt ";
    const numstat = `3\t2\t\0old\tname\n.txt\0${path}\0`;

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path, previousPath: "old\tname\n.txt", additions: 3, deletions: 2 },
    ]);
    expect(parseTurnDiffFilesFromNumstat(`1\t0\t${path}\0`)).toEqual([
      { path, additions: 1, deletions: 0 },
    ]);
  });
});

describe("prefixNumstatPaths", () => {
  it("moves plain, renamed and copied paths under the prefix", () => {
    const numstat = ["1\t0\tsrc/a.ts", "0\t0\t", "old.ts", "new.ts", "-\t-\timage.png", ""].join(
      "\0",
    );

    expect(parseTurnDiffFilesFromNumstat(prefixNumstatPaths(numstat, "api"))).toEqual([
      { path: "api/image.png", additions: 0, deletions: 0 },
      { path: "api/new.ts", previousPath: "api/old.ts", additions: 0, deletions: 0 },
      { path: "api/src/a.ts", additions: 1, deletions: 0 },
    ]);
    expect(prefixNumstatPaths("", "api")).toBe("");
  });
});

describe("prefixPatchPaths", () => {
  it("rewrites file headers and leaves hunk content alone", () => {
    const patch = [
      "diff --git a/src/a b/c.ts b/src/a b/c.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a b/c.ts",
      "+++ b/src/a b/c.ts",
      "@@ -1,2 +1,2 @@",
      "--- a/looks-like-a-header",
      "+++ b/also-content",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/added.ts b/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251.ts"',
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    expect(prefixPatchPaths(patch, "web")).toBe(
      [
        "diff --git a/web/src/a b/c.ts b/web/src/a b/c.ts",
        "index 1111111..2222222 100644",
        "--- a/web/src/a b/c.ts",
        "+++ b/web/src/a b/c.ts",
        "@@ -1,2 +1,2 @@",
        "--- a/looks-like-a-header",
        "+++ b/also-content",
        "diff --git a/web/old.ts b/web/new.ts",
        "similarity index 90%",
        "rename from web/old.ts",
        "rename to web/new.ts",
        "diff --git a/web/added.ts b/web/added.ts",
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/web/caf\\303\\251.ts"',
        "diff --git a/web/logo.png b/web/logo.png",
        "Binary files a/web/logo.png and b/web/logo.png differ",
        "",
      ].join("\n"),
    );
  });
});

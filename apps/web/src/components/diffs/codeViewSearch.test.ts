import type { CodeViewItem } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

// Find-in-diff lives in our @pierre/diffs patch and is not a package export.
const searchUrl = new URL("./components/CodeViewSearch.js", import.meta.resolve("@pierre/diffs"));
const { collectMatches } = (await import(/* @vite-ignore */ searchUrl.href)) as {
  collectMatches(
    items: ReadonlyArray<CodeViewItem<undefined>>,
    params: { text: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean },
  ): Array<{ id: string; side: string; lineNumber: number; start: number; end: number }>;
};

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const oldName = 2;
+const newName = 2;
+const added = oldName;
 const tail = 4;
@@ -20,3 +21,3 @@ function x() {
 ctx20 name
-del21 Name
+add22 names
 ctx22
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-nil
+: nil
`;

const items: CodeViewItem<undefined>[] = parsePatchFiles(PATCH)[0]!.files.map(
  (fileDiff, index) => ({ id: `file-${index}`, type: "diff", fileDiff, collapsed: index === 1 }),
);

function find(
  text: string,
  flags: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {},
) {
  return collectMatches(items, {
    text,
    caseSensitive: flags.caseSensitive ?? false,
    wholeWord: flags.wholeWord ?? false,
    regex: flags.regex ?? false,
  }).map(({ id, side, lineNumber, start, end }) => `${id}:${side}:${lineNumber}:${start}-${end}`);
}

describe("collectMatches", () => {
  it("finds removed, added, and context lines in render order, folded files included", () => {
    expect(find("oldName")).toEqual(["file-0:deletions:2:6-13", "file-0:additions:3:14-21"]);
    expect(find("nil")).toEqual(["file-1:deletions:1:0-3", "file-1:additions:1:2-5"]);
  });

  it("honours case, whole-word, and regex toggles", () => {
    expect(find("Name", { caseSensitive: true })).toEqual([
      "file-0:deletions:2:9-13",
      "file-0:additions:2:9-13",
      "file-0:additions:3:17-21",
      "file-0:deletions:21:6-10",
    ]);
    expect(find("name", { wholeWord: true })).toEqual([
      "file-0:additions:21:6-10",
      "file-0:deletions:21:6-10",
    ]);
    expect(find("n[a-z]+e", { regex: true })).toHaveLength(6);
  });

  it("returns nothing for an empty query or an invalid pattern", () => {
    expect(find("")).toEqual([]);
    expect(find("(", { regex: true })).toEqual([]);
  });
});

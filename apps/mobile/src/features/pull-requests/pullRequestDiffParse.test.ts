import { describe, expect, it } from "vite-plus/test";

import {
  markWithheldDiffFiles,
  parsedDiffFromContents,
  parseUnifiedDiff,
  pullRequestDiffChangeType,
} from "./pullRequestDiffParse";

describe("parseUnifiedDiff", () => {
  it("splits files and counts added and deleted lines", () => {
    const files = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 context
-removed
+added
+also
 context
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      displayPath: "src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(files[1]).toMatchObject({
      displayPath: "src/b.ts",
      additions: 1,
      deletions: 1,
    });
    expect(files[0]?.lines.some((line) => line.kind === "add" && line.text === "added")).toBe(true);
  });

  it("parses quoted git headers with spaces and unescapes them", () => {
    const files = parseUnifiedDiff(`diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"
--- "a/src/foo bar.ts"
+++ "b/src/foo bar.ts"
@@ -1 +1 @@
-old
+new
diff --git "a/src/quote\\"d.ts" "b/src/quote\\"d.ts"
--- "a/src/quote\\"d.ts"
+++ "b/src/quote\\"d.ts"
@@ -1 +1 @@
-old
+new
`);
    expect(files.map((file) => file.displayPath)).toEqual(["src/foo bar.ts", 'src/quote"d.ts']);
  });

  it("keeps a header-only binary file in the list", () => {
    const files = parseUnifiedDiff(`diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ
`);
    expect(files).toHaveLength(1);
    expect(files[0]?.displayPath).toBe("icon.png");
  });

  it("marks header-only files as withheld when the slice was truncated", () => {
    const files = parseUnifiedDiff(`diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
`);
    expect(markWithheldDiffFiles(files, false)[0]?.withheld).toBe(false);
    expect(markWithheldDiffFiles(files, true)[0]?.withheld).toBe(true);
    expect(pullRequestDiffChangeType(files[0]!)).toBe("change");
  });

  it("preserves /dev/null so added and deleted files expand as new or deleted", () => {
    const added = parseUnifiedDiff(`diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
`);
    const deleted = parseUnifiedDiff(`diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
`);
    expect(added[0]).toMatchObject({ oldPath: "/dev/null", newPath: "src/new.ts" });
    expect(deleted[0]).toMatchObject({ oldPath: "src/gone.ts", newPath: "/dev/null" });
    expect(pullRequestDiffChangeType(added[0]!)).toBe("new");
    expect(pullRequestDiffChangeType(deleted[0]!)).toBe("deleted");
    expect(markWithheldDiffFiles(added, true)[0]?.withheld).toBe(true);
  });

  it("expands header-only renames when the slice withheld their hunks", () => {
    const files = parseUnifiedDiff(`diff --git a/src/old.ts b/src/new.ts
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
`);
    const marked = markWithheldDiffFiles(files, true)[0]!;
    expect(marked.withheld).toBe(true);
    expect(pullRequestDiffChangeType(marked)).toBe("rename-changed");
  });

  it("builds a numbered diff from the host's full file contents", () => {
    const parsed = parsedDiffFromContents("keep\ngone\n", "keep\nadded\n");
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    expect(parsed.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "context:keep",
      "del:gone",
      "add:added",
    ]);
  });
});

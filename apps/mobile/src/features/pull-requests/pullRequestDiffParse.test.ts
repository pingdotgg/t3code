import { describe, expect, it } from "vite-plus/test";

import { parseUnifiedDiff } from "./pullRequestDiffParse";

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
});

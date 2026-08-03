import { describe, expect, it } from "vite-plus/test";

import { parseFileDiff, type DiffHunk } from "./diffPatch";
import {
  deriveHunkClusters,
  hunkActionsForSide,
  hunkAnchor,
  hunkAnnotationId,
  hunkApplyFlags,
  hunkBusyKey,
  hunkRangeLabel,
} from "./hunkActions";

function hunkAt(raw: string, index: number): DiffHunk {
  const hunk = parseFileDiff(raw)?.hunks[index];
  expect(hunk).toBeDefined();
  return hunk as DiffHunk;
}

// The anchor decides which rendered line the action cluster hangs off. Getting
// it wrong is invisible in a unit test of the patch synthesizer and very
// visible on screen (the cluster lands in the wrong hunk, or nowhere at all),
// so the fixtures below cover every body shape git emits.

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

const TRAILING_CONTEXT = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -10,5 +10,5 @@
 one
-two
+TWO
 three
 four
 five
`;

const PURE_DELETION = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-alpha
-beta
`;

const NO_NEWLINE_AT_EOF = `diff --git a/eof.txt b/eof.txt
--- a/eof.txt
+++ b/eof.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

const RENAMED_WITH_CHANGE = `diff --git a/old/name.ts b/new/name.ts
similarity index 88%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -3,3 +3,3 @@
 keep
-was
+is
`;

const CONTEXT_ONLY = `diff --git a/ctx.txt b/ctx.txt
--- a/ctx.txt
+++ b/ctx.txt
@@ -1,2 +1,2 @@
 one
 two
`;

describe("hunkApplyFlags", () => {
  it("maps each action onto the §5.5 git apply flags", () => {
    expect(hunkApplyFlags("stage")).toEqual({ cached: true });
    expect(hunkApplyFlags("unstage")).toEqual({ cached: true, reverse: true });
    expect(hunkApplyFlags("discard")).toEqual({ reverse: true });
  });

  it("never sends cached with discard — that would rewrite the index, not the worktree", () => {
    expect(hunkApplyFlags("discard").cached).toBeUndefined();
  });
});

describe("hunkActionsForSide", () => {
  it("offers stage and discard on the unstaged side", () => {
    expect(hunkActionsForSide("unstaged")).toEqual(["stage", "discard"]);
  });

  it("offers only unstage on the staged side", () => {
    expect(hunkActionsForSide("staged")).toEqual(["unstage"]);
  });
});

describe("hunkAnchor", () => {
  it("anchors to the last change line, not the last body line", () => {
    // Body: context(10) del(11→"two") add(11→"TWO") then three context lines.
    // Anchoring to the trailing context would land in a collapsible region.
    expect(hunkAnchor(hunkAt(TRAILING_CONTEXT, 0))).toEqual({
      side: "additions",
      lineNumber: 11,
    });
  });

  it("counts additions on the new side and deletions on the old side", () => {
    expect(hunkAnchor(hunkAt(TWO_HUNKS, 0))).toEqual({ side: "additions", lineNumber: 2 });
    expect(hunkAnchor(hunkAt(TWO_HUNKS, 1))).toEqual({ side: "additions", lineNumber: 21 });
  });

  it("falls back to the deletions side when the hunk only removes lines", () => {
    expect(hunkAnchor(hunkAt(PURE_DELETION, 0))).toEqual({ side: "deletions", lineNumber: 2 });
  });

  it("does not let a no-newline marker consume a line on either side", () => {
    expect(hunkAnchor(hunkAt(NO_NEWLINE_AT_EOF, 0))).toEqual({
      side: "additions",
      lineNumber: 2,
    });
  });

  it("returns null for a context-only fragment", () => {
    const parsed = parseFileDiff(CONTEXT_ONLY);
    // A context-only `@@` block still parses as a hunk; it just cannot be staged.
    expect(parsed === null || hunkAnchor(parsed.hunks[0] as DiffHunk) === null).toBe(true);
  });
});

describe("hunkRangeLabel", () => {
  it("drops the trailing context function name", () => {
    expect(hunkRangeLabel("@@ -20,2 +20,3 @@ function tail() {")).toBe("@@ -20,2 +20,3 @@");
  });

  it("leaves a bare header untouched", () => {
    expect(hunkRangeLabel("@@ -1,4 +1,4 @@")).toBe("@@ -1,4 +1,4 @@");
  });
});

describe("deriveHunkClusters", () => {
  it("returns one cluster per hunk, in render order", () => {
    const clusters = deriveHunkClusters(TWO_HUNKS, "src/foo.ts");
    expect(clusters.map((cluster) => cluster.index)).toEqual([0, 1]);
    expect(clusters.map((cluster) => cluster.label)).toEqual([
      "@@ -1,4 +1,4 @@",
      "@@ -20,2 +20,3 @@",
    ]);
  });

  it("carries the per-hunk change counts", () => {
    const [first, second] = deriveHunkClusters(TWO_HUNKS, "src/foo.ts");
    expect({ additions: first?.additions, deletions: first?.deletions }).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect({ additions: second?.additions, deletions: second?.deletions }).toEqual({
      additions: 1,
      deletions: 0,
    });
  });

  it("synthesizes a one-hunk patch that carries only that hunk's body", () => {
    const clusters = deriveHunkClusters(TWO_HUNKS, "src/foo.ts");
    const second = clusters[1]?.patch ?? "";
    expect(second).toContain("diff --git a/src/foo.ts b/src/foo.ts");
    expect(second).toContain("+  // added");
    expect(second).not.toContain("const b = 22");
    expect(second.endsWith("\n")).toBe(true);
  });

  it("addresses a renamed file by its new path on both sides", () => {
    const [cluster] = deriveHunkClusters(RENAMED_WITH_CHANGE, "new/name.ts");
    expect(cluster?.patch).toContain("diff --git a/new/name.ts b/new/name.ts");
    expect(cluster?.patch).toContain("--- a/new/name.ts");
    expect(cluster?.patch).toContain("+++ b/new/name.ts");
    expect(cluster?.patch).not.toContain("old/name.ts");
  });

  it("keeps the no-newline markers in the synthesized patch", () => {
    const [cluster] = deriveHunkClusters(NO_NEWLINE_AT_EOF, "eof.txt");
    const markers = (cluster?.patch.match(/\\ No newline at end of file/g) ?? []).length;
    expect(markers).toBe(2);
  });

  it("returns nothing for a diff with no textual hunk", () => {
    expect(deriveHunkClusters("", "x.txt")).toEqual([]);
    expect(
      deriveHunkClusters(
        "diff --git a/bin b/bin\nindex 111..222 100644\nBinary files a/bin and b/bin differ\n",
        "bin",
      ),
    ).toEqual([]);
  });
});

describe("identities", () => {
  it("are stable per file and hunk, so an annotation never re-lays-out the diff", () => {
    expect(hunkAnnotationId("src/foo.ts:key", 2)).toBe("hunk:src/foo.ts:key:2");
    expect(hunkAnnotationId("src/foo.ts:key", 2)).toBe(hunkAnnotationId("src/foo.ts:key", 2));
  });

  it("give each hunk action its own busy key", () => {
    expect(hunkBusyKey(1, "stage")).toBe("hunk:1:stage");
    expect(hunkBusyKey(1, "discard")).not.toBe(hunkBusyKey(1, "stage"));
  });
});

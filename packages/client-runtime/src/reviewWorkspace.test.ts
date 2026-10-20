import { reviewFileGroup } from "@t3tools/shared/reviewFileClassification";
import { describe, expect, it } from "vite-plus/test";
import {
  pullRequestMergeRequirementsUnmet,
  isReviewFileVisible,
  latestReviewedCommit,
  orderReviewFiles,
  reviewCommentCounts,
  reviewCommitScope,
  reviewCommitSelection,
  reviewFileTreeRows,
  reviewFolderContains,
  reviewPatchHunks,
  reviewHunkPatch,
  reviewRenameSegments,
  toggleReviewCommit,
} from "./reviewWorkspace.ts";

describe("merge requirement confirmation", () => {
  it("uses the host's complete requirements verdict before check fallbacks", () => {
    expect(
      pullRequestMergeRequirementsUnmet({
        mergeRequirementsSatisfied: true,
        checks: [{ status: "failure" }],
        reviewDecision: "review-required",
        baseBehind: true,
      }),
    ).toBe(false);
    expect(
      pullRequestMergeRequirementsUnmet({
        mergeRequirementsSatisfied: false,
        checks: [{ status: "success" }],
        baseBehind: false,
      }),
    ).toBe(true);
  });
  it("falls back to pending checks, review requirements, and branch freshness", () => {
    const ready = { checks: [{ status: "success" as const }], baseBehind: false };
    expect(pullRequestMergeRequirementsUnmet(ready)).toBe(false);
    expect(pullRequestMergeRequirementsUnmet({ ...ready, checks: [{ status: "pending" }] })).toBe(
      true,
    );
    expect(
      pullRequestMergeRequirementsUnmet({ ...ready, reviewDecision: "changes-requested" }),
    ).toBe(true);
    expect(pullRequestMergeRequirementsUnmet({ ...ready, baseBehind: true })).toBe(true);
  });
});

it("matches inline staging to its patch range even when hunk context is expanded", () => {
  const first =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@ same function\n-old\n+new\n";
  const second = first.replace("@@ -1,2 +1,2 @@", "@@ -30,2 +30,2 @@");
  expect(reviewHunkPatch([second, first], "@@ -1,2 +1,2 @@ other display context")).toBe(first);
  expect(reviewHunkPatch([first, second], "@@ -30,2 +30,2 @@")).toBe(second);
});

it("does not stage a neighboring hunk when the displayed range is stale or not a hunk", () => {
  const patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  expect(reviewHunkPatch([patch], "@@ -2 +2 @@")).toBeUndefined();
  expect(reviewHunkPatch([patch], "ordinary code")).toBeUndefined();
  expect(reviewHunkPatch([patch], "@@ -1,1 +1,1 @@")).toBe(patch);
});

describe("inline rename paths", () => {
  it("highlights only the changed filename text and keeps the shared extension plain", () => {
    expect(
      reviewRenameSegments("src/MichaelsAPIUtils.test.ts", "src/michaels-api.test.ts"),
    ).toEqual([
      { text: "MichaelsAPIUtils", kind: "removed" },
      { text: ".test.ts", kind: "unchanged" },
      { text: " → ", kind: "context" },
      { text: "michaels-api", kind: "added" },
      { text: ".test.ts", kind: "unchanged" },
      { text: "  ", kind: "context" },
      { text: "src", kind: "context" },
    ]);
  });

  it("shows directory-only moves inline without inventing a filename change", () => {
    const parts = reviewRenameSegments("src/old/a.ts", "src/new/a.ts", false);
    expect(parts.map((part) => part.text).join("")).toBe("a.ts  src/old → src/new");
    expect(parts.filter((part) => part.kind === "removed").map((part) => part.text)).toEqual([
      "old",
    ]);
    expect(parts.filter((part) => part.kind === "added").map((part) => part.text)).toEqual(["new"]);
  });

  it("omits shared directory context in a tree and keeps Unicode characters intact", () => {
    const parts = reviewRenameSegments("src/😀.ts", "src/😁.ts", false);
    expect(parts.map((part) => part.text).join("")).toBe("😀.ts → 😁.ts");
    expect(parts.find((part) => part.kind === "removed")?.text).toBe("😀");
    expect(
      reviewRenameSegments("a.ts", "src/a.ts")
        .map((part) => part.text)
        .join(""),
    ).toBe("a.ts  . → src");
  });
});

describe("shared review workspace", () => {
  it("keeps each expanded subtree alphabetical with folders before files", () => {
    expect(
      orderReviewFiles(["z.ts", "src/z.ts", "src/a/z.ts", "src/a/a.ts", "a.ts"], (path) => path),
    ).toEqual(["src/a/a.ts", "src/a/z.ts", "src/z.ts", "a.ts", "z.ts"]);
    expect(reviewFolderContains("src/a", "src/another.ts")).toBe(false);
    expect(reviewFolderContains("src/a", "src/a/z.ts")).toBe(true);
  });
  it("groups tests and generated output without cloning file metadata", () => {
    const files = [
      { path: "pnpm-lock.yaml", id: 1 },
      { path: "src/foo.test.ts", id: 2 },
      { path: "src/foo.ts", id: 3 },
    ];
    expect(orderReviewFiles(files, (file) => file.path, true)).toEqual([
      files[2],
      files[1],
      files[0],
    ]);
    expect(reviewFileGroup("src/__snapshots__/foo.snap")).toBe("generated");
    expect(reviewFileGroup("Tests/FooTests.swift")).toBe("tests");
  });
  it("attributes unresolved conversations on renamed files to their current path", () => {
    const counts = reviewCommentCounts(
      [{ path: "new.ts", previousPath: "old.ts" }],
      [
        { path: "old.ts", isResolved: false },
        { path: "new.ts", isResolved: true },
      ],
    );
    expect(counts.get("new.ts")).toEqual({ total: 2, unresolved: 1 });
    expect(isReviewFileVisible({ commentsOnly: true, hideReviewed: true }, true, true)).toBe(false);
    expect(isReviewFileVisible({ commentsOnly: true, hideReviewed: false }, true, true)).toBe(true);
  });
  it("counts unpublished comments once while keeping unresolved replies in their conversation", () => {
    const threads = [
      {
        path: "src/a.ts",
        isResolved: false,
        comments: [{ id: "published" }, { id: "reply" }],
      },
      {
        path: "src/a.ts",
        isResolved: false,
        comments: [{ id: "private", pendingReviewId: "review" }],
      },
      {
        path: "src/a.ts",
        isResolved: true,
        comments: [{ id: "resolved" }],
      },
    ];
    const counts = reviewCommentCounts([{ path: "src/a.ts" }], threads, [
      { path: "src/a.ts", id: "local-copy", hostedComment: { commentId: "private" } },
      { path: "src/a.ts", id: "private", hostedComment: { commentId: "private" } },
      { path: "src/a.ts", id: "unsaved-one" },
      { path: "src/a.ts", id: "unsaved-two" },
    ]);
    expect(counts.get("src/a.ts")).toEqual({ total: 5, unresolved: 4 });
    expect(reviewCommentCounts([{ path: "src/a.ts" }], threads).get("src/a.ts")).toEqual({
      total: 3,
      unresolved: 2,
    });
  });
  it("keeps pending replies actionable in resolved conversations and renamed files", () => {
    const counts = reviewCommentCounts(
      [{ path: "src/new.ts", previousPath: "src/old.ts" }],
      [
        {
          path: "src/old.ts",
          isResolved: true,
          comments: [
            { id: "resolved" },
            { id: "pending-one", pendingReviewId: "review" },
            { id: "pending-two", pendingReviewId: "review" },
          ],
        },
      ],
    );
    expect(counts.get("src/new.ts")).toEqual({ total: 3, unresolved: 2 });
    expect(counts.has("src/old.ts")).toBe(false);
    expect(
      isReviewFileVisible(
        { commentsOnly: true },
        false,
        (counts.get("src/new.ts")?.unresolved ?? 0) > 0,
      ),
    ).toBe(true);
  });
  it("does not resurrect removed host drafts or count a submitted draft twice", () => {
    const files = [{ path: "a.ts" }];
    const privateThread = {
      path: "a.ts",
      isResolved: false,
      comments: [{ id: "private", pendingReviewId: "review" }],
    };
    expect(reviewCommentCounts(files, [privateThread], []).has("a.ts")).toBe(false);
    const publishedThread = {
      ...privateThread,
      comments: [{ id: "private" }],
    };
    expect(
      reviewCommentCounts(
        files,
        [publishedThread],
        [{ path: "a.ts", id: "local-copy", hostedComment: { commentId: "private" } }],
      ).get("a.ts"),
    ).toEqual({ total: 1, unresolved: 1 });
    expect(
      reviewCommentCounts(
        files,
        [{ ...publishedThread, isResolved: true }],
        [{ path: "a.ts", id: "local-copy", hostedComment: { commentId: "private" } }],
      ).get("a.ts"),
    ).toEqual({ total: 1, unresolved: 0 });
  });
  it("fills commit gaps, trims endpoints and keeps a contiguous range after interior removal", () => {
    const commits = ["a", "b", "c", "d", "e"];
    expect(toggleReviewCommit(commits, ["b"], "e")).toEqual(["b", "c", "d", "e"]);
    expect(toggleReviewCommit(commits, ["b", "c", "d", "e"], "b")).toEqual(["c", "d", "e"]);
    expect(toggleReviewCommit(commits, commits, "b")).toEqual(["c", "d", "e"]);
    expect(reviewCommitSelection(commits, reviewCommitScope(["b", "c", "d"]))).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(reviewCommitSelection(commits, "missing..e")).toEqual([]);
  });
  it("finds the viewer's most recent review commit including reviews without a summary", () => {
    expect(
      latestReviewedCommit(
        [
          {
            kind: "review",
            author: { login: "Jake" },
            createdAt: "2026-10-01",
            reviewCommitSha: "old",
          },
          {
            kind: "review",
            author: { login: "other" },
            createdAt: "2026-10-03",
            reviewCommitSha: "other",
          },
          {
            kind: "review",
            author: { login: "jake" },
            createdAt: "2026-10-02",
            reviewCommitSha: "latest",
          },
          {
            kind: "review",
            author: { login: "jake" },
            createdAt: "2026-10-04",
            reviewCommitSha: "private-draft",
            reviewState: "PENDING",
          },
        ],
        "JAKE",
      ),
    ).toBe("latest");
    expect(
      latestReviewedCommit(
        [
          {
            kind: "review",
            author: { login: "jake" },
            createdAt: "2026-10-04",
            reviewCommitSha: "private-draft",
            reviewState: "pending",
          },
        ],
        "Jake",
      ),
    ).toBeNull();
  });
  it("extracts individual staging patches without stale whole-file blob IDs", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\nindex abc..def 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-before\n+after\n";
    const [file] = reviewPatchHunks(patch);
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]).toContain("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@");
    expect(file?.hunks[0]).not.toContain("index ");
    expect(file?.hunks[0]).not.toContain("@@ -20");
  });
});

it("renders nested folder rows without children of collapsed folders or duplicate ancestors", () => {
  const rows = reviewFileTreeRows(
    ["src/a/b.ts", "src/z.ts", "README.md"],
    (path) => path,
    new Set(["src/a"]),
  );
  expect(rows.map((row) => [row.kind, row.path, row.depth])).toEqual([
    ["folder", "src", 0],
    ["folder", "src/a", 1],
    ["file", "src/z.ts", 1],
    ["file", "README.md", 0],
  ]);
});

it("compacts single-child chains while keeping folder actions and collapse at the full path", () => {
  const paths = [
    "packages/artelo/src/api/a.ts",
    "packages/artelo/src/api/b.ts",
    "packages/artelo/src/tests/a.test.ts",
  ];
  const rows = reviewFileTreeRows(paths, (path) => path, new Set());
  expect(rows.map((row) => [row.kind, row.path, row.depth])).toEqual([
    ["folder", "packages/artelo/src", 0],
    ["folder", "packages/artelo/src/api", 1],
    ["file", "packages/artelo/src/api/a.ts", 2],
    ["file", "packages/artelo/src/api/b.ts", 2],
    ["folder", "packages/artelo/src/tests", 1],
    ["file", "packages/artelo/src/tests/a.test.ts", 2],
  ]);
  expect(rows[0]).toMatchObject({ label: "packages/artelo/src" });
  expect(reviewFileTreeRows(paths, (path) => path, new Set(["packages/artelo/src"]))).toEqual([
    { kind: "folder", path: "packages/artelo/src", label: "packages/artelo/src", depth: 0 },
  ]);
});

it("keeps staging available in retained context windows and excludes adjacent edits", () => {
  const header = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const near = header + "@@ -14 +14 @@\n-old near\n+new near\n";
  const middle = header + "@@ -24 +24 @@\n-old middle\n+new middle\n";
  const far = header + "@@ -40 +40 @@\n-old far\n+new far\n";
  const chosen = reviewHunkPatch([near, middle, far], "@@ -10,20 +10,20 @@");
  expect(chosen).toBe(header + near.slice(header.length) + middle.slice(header.length));
  expect(chosen).not.toContain("new far");
  expect(reviewHunkPatch([near, middle, far], "@@ -12,5 +12,5 @@")).toBe(near);
});

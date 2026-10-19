import { describe, expect, it } from "vite-plus/test";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { combinePullRequestDiffPages, retainPullRequestDiffPage } from "./pullRequestDiffPages";

function diff(path: string): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
    nextCursor: null,
  };
}

function withheldDiff(): PullRequestDiffResult {
  return {
    patch: "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n",
    truncated: true,
    nextCursor: null,
    omittedFileStats: [{ path: "large.ts", additions: 3000, deletions: 1800 }],
  };
}

describe("paged mobile pull request diffs", () => {
  it("withheld PR hunks must retain provider line counts", () => {
    const result = withheldDiff();
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const pages = [{ cursor: null, result }];
    const parsed = combinePullRequestDiffPages(pages, cache, "pr");
    if (parsed.kind !== "files") throw new Error("Expected structured diff");
    expect(parsed.files[0]).toMatchObject({
      path: "large.ts",
      additions: 3000,
      deletions: 1800,
      rows: [],
    });
    expect(parsed.additions).toBe(3000);
    expect(parsed.deletions).toBe(1800);
    expect(parsed.notice).toBe(
      "Some file contents are unavailable. Open the pull request on its provider to see the full changes.",
    );
    const cached = combinePullRequestDiffPages(pages, cache, "pr");
    if (cached.kind !== "files") throw new Error("Expected structured diff");
    expect(cached.files[0]).toBe(parsed.files[0]);
  });

  it("combines normal and withheld pages and refreshes counts with unchanged patch text", () => {
    const first = { ...diff("first.ts"), nextCursor: "second" };
    const withheld = withheldDiff();
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const pages = retainPullRequestDiffPage(
      retainPullRequestDiffPage([], null, first),
      "second",
      withheld,
    );
    const before = combinePullRequestDiffPages(pages, cache, "pr");
    if (before.kind !== "files") throw new Error("Expected structured diff");
    expect(before.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ["first.ts", 1, 1],
      ["large.ts", 3000, 1800],
    ]);
    expect(before.additions).toBe(3001);
    expect(before.deletions).toBe(1801);

    const refreshed = retainPullRequestDiffPage(pages, "second", {
      ...withheld,
      omittedFileStats: [{ path: "large.ts", additions: 4000, deletions: 2000 }],
    });
    const after = combinePullRequestDiffPages(refreshed, cache, "pr");
    if (after.kind !== "files") throw new Error("Expected structured diff");
    expect(after.files[0]).toBe(before.files[0]);
    expect(after.files[1]?.id).toBe(before.files[1]?.id);
    expect(after.files[1]).toMatchObject({ additions: 4000, deletions: 2000, rows: [] });
    expect(after.additions).toBe(4001);
    expect(after.deletions).toBe(2001);
    expect(after.notice).toBe(before.notice);
    expect(before.additions).toBe(3001);
  });
  it("retains file order and IDs when another page arrives", () => {
    const first = { ...diff("first.ts"), nextCursor: "second" };
    const pages = retainPullRequestDiffPage([], null, first);
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const before = combinePullRequestDiffPages(pages, cache, "pr");
    const after = combinePullRequestDiffPages(
      retainPullRequestDiffPage(pages, "second", diff("second.ts")),
      cache,
      "pr",
    );
    expect(before.kind).toBe("files");
    expect(after.kind).toBe("files");
    if (before.kind !== "files" || after.kind !== "files")
      throw new Error("Expected structured diff");
    expect(after.files.map((file) => file.path)).toEqual(["first.ts", "second.ts"]);
    expect(after.files[0]).toBe(before.files[0]);
    expect(after.additions).toBe(2);
  });

  it("discards later pages when a refreshed page changes", () => {
    const first = diff("first.ts");
    const pages = retainPullRequestDiffPage(
      retainPullRequestDiffPage([], null, first),
      "second",
      diff("second.ts"),
    );
    expect(retainPullRequestDiffPage(pages, null, first)).toBe(pages);
    expect(retainPullRequestDiffPage(pages, null, { ...first })).toBe(pages);
    const refreshed = retainPullRequestDiffPage(pages, null, diff("changed.ts"));
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.result.patch).toContain("changed.ts");
  });
});

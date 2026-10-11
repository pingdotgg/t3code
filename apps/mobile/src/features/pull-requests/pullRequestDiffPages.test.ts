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

describe("paged mobile pull request diffs", () => {
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

import { describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as reviewModel from "../review/reviewModel";
import {
  combinePullRequestDiffPages,
  getCachedPullRequestDiffPages,
  retainPullRequestDiffPage,
} from "./pullRequestDiffPages";

const GITHUB = sourceControlClients.get("github").changeRequest;

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
  it("isolates scopes, cursors, and provider terminology for the same result", () => {
    const result = withheldDiff();
    const pages = [{ cursor: null, result }];
    const first = getCachedPullRequestDiffPages(pages, "first", GITHUB);
    const otherScope = getCachedPullRequestDiffPages(pages, "second", GITHUB);
    const otherCursor = getCachedPullRequestDiffPages(
      [{ cursor: "next", result }],
      "first",
      GITHUB,
    );
    const otherProvider = getCachedPullRequestDiffPages(
      pages,
      "first",
      sourceControlClients.get("gitlab").changeRequest,
    );
    expect(otherScope).not.toBe(first);
    expect(otherCursor).not.toBe(first);
    expect(otherProvider).not.toBe(first);
    if (first.kind !== "files" || otherScope.kind !== "files" || otherProvider.kind !== "files")
      throw new Error("Expected structured files");
    expect(otherScope.files[0]?.id).not.toBe(first.files[0]?.id);
    expect(first.notice).toContain("pull request");
    expect(otherProvider.notice).toContain("merge request");
    expect(getCachedPullRequestDiffPages(pages, "first", GITHUB)).toBe(first);
  });

  it("reuses earlier pages on append and invalidates changed continuation results", () => {
    using parse = vi.spyOn(reviewModel, "buildReviewParsedDiff");
    const firstPage = { cursor: null, result: diff("first.ts") };
    const first = getCachedPullRequestDiffPages([firstPage], "append", GITHUB);
    const nextPage = { cursor: "next", result: withheldDiff() };
    const combined = getCachedPullRequestDiffPages([firstPage, nextPage], "append", GITHUB);
    expect(parse).toHaveBeenCalledTimes(2);
    if (first.kind !== "files" || combined.kind !== "files") throw new Error("Expected files");
    expect(combined.files[0]).toBe(first.files[0]);
    expect(combined.files.map((file) => file.path)).toEqual(["first.ts", "large.ts"]);
    expect(getCachedPullRequestDiffPages([firstPage, nextPage], "append", GITHUB)).toBe(combined);
    const refreshed = getCachedPullRequestDiffPages(
      [
        firstPage,
        {
          ...nextPage,
          result: {
            ...nextPage.result,
            omittedFileStats: [{ path: "large.ts", additions: 4000, deletions: 2000 }],
          },
        },
      ],
      "append",
      GITHUB,
    );
    expect(parse).toHaveBeenCalledTimes(3);
    expect(refreshed).not.toBe(combined);
    if (refreshed.kind !== "files") throw new Error("Expected refreshed files");
    expect(refreshed.files[0]).toBe(first.files[0]);
    expect(refreshed.files[1]).toMatchObject({ additions: 4000, deletions: 2000 });
    expect(combined.files[1]?.additions).toBe(3000);
  });

  it("withheld PR hunks must retain provider line counts", () => {
    const result = withheldDiff();
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const pages = [{ cursor: null, result }];
    const parsed = combinePullRequestDiffPages(pages, cache, "pr", GITHUB);
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
    const cached = combinePullRequestDiffPages(pages, cache, "pr", GITHUB);
    if (cached.kind !== "files") throw new Error("Expected structured diff");
    expect(cached.files[0]).toBe(parsed.files[0]);
  });

  it("points a withheld merge request diff at the merge request", () => {
    const parsed = combinePullRequestDiffPages(
      [{ cursor: null, result: withheldDiff() }],
      new WeakMap(),
      "mr",
      sourceControlClients.get("gitlab").changeRequest,
    );
    expect(parsed.kind === "files" ? parsed.notice : null).toBe(
      "Some file contents are unavailable. Open the merge request on its provider to see the full changes.",
    );
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
    const before = combinePullRequestDiffPages(pages, cache, "pr", GITHUB);
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
    const after = combinePullRequestDiffPages(refreshed, cache, "pr", GITHUB);
    if (after.kind !== "files") throw new Error("Expected structured diff");
    expect(after.files[0]).toBe(before.files[0]);
    expect(after.files[1]?.id).toBe(before.files[1]?.id);
    expect(after.files[1]).toMatchObject({ additions: 4000, deletions: 2000, rows: [] });
    expect(after.additions).toBe(4001);
    expect(after.deletions).toBe(2001);
    expect(after.notice).toBe(before.notice);
    expect(before.additions).toBe(3001);
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

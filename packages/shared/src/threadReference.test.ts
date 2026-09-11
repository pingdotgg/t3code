import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadReferenceCopyTarget, threadHandoverSourceKey } from "./threadReference.ts";

const crossRepositoryPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "other/repo",
  number: 42,
  url: "https://github.com/other/repo/pull/42",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

describe("resolveThreadReferenceCopyTarget", () => {
  it("does not copy another reference while the open panel URL is unavailable", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        openPanelPullRequestUrl: null,
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toBeNull();
  });

  it("prefers the open panel pull request over the thread pull request", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        openPanelPullRequestUrl: "https://github.com/t3/pr/14",
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/14",
      successTitle: "PR link copied",
    });
  });

  it.each([null, "https://github.com/t3/pr/12"])(
    "copies a native cross-repository link before the fallback URL %s",
    (linkedPullRequestUrl) => {
      expect(
        resolveThreadReferenceCopyTarget({
          threadId: "thread-1",
          pullRequests: [crossRepositoryPullRequest],
          linkedPullRequestUrl,
        }),
      ).toMatchObject({
        kind: "pull-request",
        value: crossRepositoryPullRequest.url,
      });
    },
  );

  it("copies the highest open stack layer instead of the first link", () => {
    const stack: NonNullable<ThreadPullRequestLink["stack"]> = {
      kind: "native",
      id: "stack-1",
      number: 1,
      url: "https://github.com/other/repo/stacks/1",
      base: "main",
      layers: [
        { number: 42, headBranch: "first", state: "open" },
        { number: 43, headBranch: "second", state: "open" },
      ],
    };
    const top = {
      ...crossRepositoryPullRequest,
      number: 43,
      url: "https://github.com/other/repo/pull/43",
      stack,
    };
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        pullRequests: [{ ...crossRepositoryPullRequest, stack }, top],
      }),
    ).toMatchObject({ kind: "pull-request", value: top.url });
  });

  it("uses the fallback URL when native links are dismissed", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        pullRequests: [{ ...crossRepositoryPullRequest, source: "stack-dismissed" }],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({ kind: "pull-request", value: "https://github.com/t3/pr/12" });
  });

  it("uses the thread pull request when no panel is open", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/12",
      successTitle: "PR link copied",
    });
  });

  it("falls back to the thread ID", () => {
    expect(resolveThreadReferenceCopyTarget({ threadId: "thread-1" })).toEqual({
      kind: "thread",
      value: "thread-1",
      clipboardTarget: "thread ID",
      successTitle: "Thread ID copied",
      failureTitle: "Failed to copy thread ID",
    });
  });
});

describe("threadHandoverSourceKey", () => {
  it("keeps opaque environment and thread IDs unambiguous", () => {
    expect(threadHandoverSourceKey("a:b", "c")).not.toBe(threadHandoverSourceKey("a", "b:c"));
  });
});

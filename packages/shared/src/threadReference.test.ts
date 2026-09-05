import { describe, expect, it } from "vite-plus/test";

import { resolveThreadReferenceCopyTarget } from "./threadReference.ts";

describe("resolveThreadReferenceCopyTarget", () => {
  it("does not copy another reference while the open panel URL is unavailable", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        openPanelPullRequestUrl: null,
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
        detectedPullRequestUrl: "https://github.com/t3/pr/13",
      }),
    ).toBeNull();
  });

  it("prefers the open panel pull request over linked and detected pull requests", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        openPanelPullRequestUrl: "https://github.com/t3/pr/14",
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
        detectedPullRequestUrl: "https://github.com/t3/pr/13",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/14",
      successTitle: "PR link copied",
    });
  });

  it("prefers a durable linked pull request", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
        detectedPullRequestUrl: "https://github.com/t3/pr/13",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/12",
      successTitle: "PR link copied",
    });
  });

  it("uses a pull request detected from the active branch", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        detectedPullRequestUrl: "https://github.com/t3/pr/13",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/13",
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

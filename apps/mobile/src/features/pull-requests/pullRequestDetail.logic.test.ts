import type {
  PullRequestComment,
  PullRequestDetailView,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFixFindingsPrompt,
  buildPullRequestTimeline,
  buildResolveConflictsPrompt,
  countResolvedReviewThreads,
  countUnresolvedReviewThreads,
  describePullRequestConversationSummary,
  describePullRequestState,
  groupPullRequestConversation,
  groupPullRequestTimelineConversations,
  orderPullRequestComments,
  pullRequestUrlHost,
  readableFailure,
} from "./pullRequestDetail.logic";

const TIMELINE_SOURCE: Pick<
  PullRequestDetailView,
  "createdAt" | "author" | "commits" | "comments" | "mergedAt" | "closedAt"
> = {
  createdAt: "2026-07-01T00:00:00Z",
  author: { login: "octocat", name: null, avatarUrl: null },
  commits: [
    { oid: "1baf7bdcafe", messageHeadline: "add the page", committedDate: "2026-07-02T00:00:00Z" },
  ],
  comments: [
    {
      id: "c1",
      kind: "issue-comment",
      author: { login: "reviewer", name: null, avatarUrl: null },
      body: "looks good",
      createdAt: "2026-07-03T00:00:00Z",
      url: "https://github.com/pingdotgg/t3code/pull/1#issuecomment-1",
      path: null,
      reviewState: null,
    },
  ],
  mergedAt: null,
  closedAt: null,
};

describe("pull request state description", () => {
  it("keeps draft and conflicts orthogonal to the terminal states", () => {
    expect(describePullRequestState("merged", true)).toBe("Merged");
    expect(describePullRequestState("closed", true)).toBe("Closed");
    expect(describePullRequestState("open", true)).toBe("Draft");
    expect(describePullRequestState("open", false)).toBe("Ready for review");
  });
});

describe("ordering comments", () => {
  it("reverses the chronological list for newest first, and leaves oldest first alone", () => {
    const comments = [{ createdAt: "2026-07-01T00:00:00Z" }, { createdAt: "2026-07-02T00:00:00Z" }];
    expect(orderPullRequestComments(comments, "oldest")).toEqual(comments);
    expect(orderPullRequestComments(comments, "newest").map((item) => item.createdAt)).toEqual([
      "2026-07-02T00:00:00Z",
      "2026-07-01T00:00:00Z",
    ]);
  });
});

describe("grouping the conversation", () => {
  const thread: PullRequestReviewThread = {
    id: "t1",
    path: "src/app.ts",
    line: 12,
    side: "right",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: "rc1",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "nit",
        createdAt: "2026-07-02T00:00:00Z",
        url: null,
      },
      {
        id: "rc2",
        author: { login: "octocat", name: null, avatarUrl: null },
        body: "fixed",
        createdAt: "2026-07-03T00:00:00Z",
        url: null,
      },
    ],
  };
  const comments: PullRequestComment[] = [
    {
      id: "rc1",
      kind: "review-comment",
      author: { login: "reviewer", name: null, avatarUrl: null },
      body: "nit",
      createdAt: "2026-07-02T00:00:00Z",
      url: null,
      path: "src/app.ts",
      reviewState: null,
    },
    {
      id: "rc2",
      kind: "review-comment",
      author: { login: "octocat", name: null, avatarUrl: null },
      body: "fixed",
      createdAt: "2026-07-03T00:00:00Z",
      url: null,
      path: "src/app.ts",
      reviewState: null,
    },
    {
      id: "c1",
      kind: "issue-comment",
      author: { login: "octocat", name: null, avatarUrl: null },
      body: "thanks",
      createdAt: "2026-07-04T00:00:00Z",
      url: null,
      path: null,
      reviewState: null,
    },
  ];

  it("emits a review thread once, at the first of its comments in reading order", () => {
    const items = groupPullRequestConversation(comments, [thread], "oldest");
    expect(items.map((item) => item.kind)).toEqual(["thread", "comment"]);
  });

  it("keeps a thread whose comments never appeared in the flat feed", () => {
    const items = groupPullRequestConversation([], [thread], "newest");
    expect(items).toEqual([{ kind: "thread", thread }]);
  });

  it("counts resolved conversations separately from open ones", () => {
    expect(countUnresolvedReviewThreads([thread, { ...thread, id: "t2", isResolved: true }])).toBe(
      1,
    );
    expect(countResolvedReviewThreads([thread, { ...thread, id: "t2", isResolved: true }])).toBe(1);
  });

  it("names whether review conversations still need work", () => {
    expect(
      describePullRequestConversationSummary({
        commentCount: 3,
        unresolvedThreadCount: 1,
        resolvedThreadCount: 1,
      }),
    ).toBe("3 comments · 1 unresolved");
    expect(
      describePullRequestConversationSummary({
        commentCount: 1,
        unresolvedThreadCount: 0,
        resolvedThreadCount: 2,
      }),
    ).toBe("1 comment · all resolved");
  });
});

describe("pull request timeline", () => {
  it("orders creation, commits and comments newest first", () => {
    expect(buildPullRequestTimeline(TIMELINE_SOURCE).map((event) => event.kind)).toEqual([
      "comment",
      "commit",
      "opened",
    ]);
  });

  it("reports a merge rather than the close GitHub records alongside it", () => {
    expect(
      buildPullRequestTimeline({
        ...TIMELINE_SOURCE,
        mergedAt: "2026-07-05T00:00:00Z",
        closedAt: "2026-07-05T00:00:00Z",
      }).map((event) => event.kind),
    ).toEqual(["merged", "comment", "commit", "opened"]);
  });

  it("drops a body that is nothing but a bot's HTML comment, and keeps one that says more", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      comments: [
        { ...TIMELINE_SOURCE.comments[0]!, body: "<!-- MURMUR_IGNORE -->" },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "c2",
          body: "<!-- summarize by coderabbit.ai -->\nNeeds a test.",
          createdAt: "2026-07-04T00:00:00Z",
        },
      ],
    });
    expect(events.find((event) => event.id === "c1")?.body).toBeNull();
    expect(events.find((event) => event.id === "c2")?.body).toBe(
      "<!-- summarize by coderabbit.ai -->\nNeeds a test.",
    );
  });

  it("groups conversation sections without crossing commits or PR updates", () => {
    const events = buildPullRequestTimeline(TIMELINE_SOURCE);
    expect(groupPullRequestTimelineConversations(events).map((row) => row.kind)).toEqual([
      "comments",
      "event",
      "event",
    ]);
  });
});

describe("handoffs and failures", () => {
  it("names the conflicting branches in the resolve-conflicts prompt", () => {
    expect(
      buildResolveConflictsPrompt({
        number: 12,
        url: "https://github.com/acme/app/pull/12",
        headBranch: "feat/login",
        baseBranch: "main",
      }),
    ).toContain("`main`");
  });

  it("reads the hostname from the pull request URL", () => {
    expect(pullRequestUrlHost("https://github.acme.test/org/repo/pull/1")).toBe("github.acme.test");
    expect(pullRequestUrlHost("not a url")).toBeNull();
  });

  it("prefers the host's own sentence over a generic hint", () => {
    expect(readableFailure(new Error("Branch is out of date"), "try again")).toBe(
      "Branch is out of date",
    );
    expect(readableFailure(new Error("GitHub CLI command failed."), "Check write access.")).toBe(
      "Check write access.",
    );
  });

  const findingsBase = {
    provider: "github" as const,
    host: "github.com",
    number: 42,
    title: "Add the page",
    url: "https://github.com/acme/app/pull/42",
    headBranch: "feat/page",
    baseBranch: "main",
    reviewThreads: [] as PullRequestReviewThread[],
    comments: [] as PullRequestComment[],
    checks: [],
    commentsTruncated: false,
    canResolve: true,
  };

  it("omits a thread whose comments are only HTML markers", () => {
    const prompt = buildFixFindingsPrompt({
      ...findingsBase,
      reviewThreads: [
        {
          id: "t1",
          path: "src/app.ts",
          line: 12,
          side: "right",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "rc1",
              author: { login: "reviewer", name: null, avatarUrl: null },
              body: "<!-- MURMUR_IGNORE -->",
              createdAt: "2026-07-02T00:00:00Z",
              url: null,
            },
          ],
        },
      ],
    });
    expect(prompt).toContain("No unresolved review findings were returned");
    expect(prompt).not.toContain("MURMUR_IGNORE");
  });

  it("does not treat a general issue comment as a review finding", () => {
    const prompt = buildFixFindingsPrompt({
      ...findingsBase,
      comments: [
        {
          id: "c1",
          kind: "issue-comment",
          author: { login: "octocat", name: null, avatarUrl: null },
          body: "please also update the docs",
          createdAt: "2026-07-03T00:00:00Z",
          url: null,
          path: null,
          reviewState: null,
        },
      ],
    });
    expect(prompt).not.toContain("update the docs");
  });

  it("carries a review submitted with words but no line", () => {
    const prompt = buildFixFindingsPrompt({
      ...findingsBase,
      comments: [
        {
          id: "r1",
          kind: "review",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body: "This breaks SSO auth, revert the middleware change.",
          createdAt: "2026-07-03T00:00:00Z",
          url: null,
          path: null,
          reviewState: "CHANGES_REQUESTED",
        },
      ],
    });
    expect(prompt).toContain("revert the middleware change");
    expect(prompt).not.toContain("No unresolved review findings");
  });
});

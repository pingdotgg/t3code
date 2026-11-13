import { SourceControlProviderKind } from "@t3tools/contracts";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import {
  GitCommandError,
  ProjectId,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestDetailView,
  type PullRequestRef,
  type PullRequestReviewThread,
  type PullRequestState,
  type RepositoryIdentity,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { buildMessageContext, reviewCommentContextReference } from "~/lib/composerContextRecords";
import {
  buildAddSelectionToAgentHandoff,
  buildExplainPullRequestHandoff,
  buildResolveConflictsPrompt,
  resolveThreadPanelPullRequestAction,
  buildPullRequestReferenceContext,
  buildFixFindingHandoff,
  canDeletePullRequestBranch,
  buildFixFindingsHandoff,
  groupPullRequestTimelineConversations,
  filterPullRequestConversationItems,
  pagePullRequestConversationItems,
  pullRequestConversationItemComments,
  pullRequestConversationItems,
  handoffPrompt,
  handoffReviewComments,
  stripPullRequestHandoffReferences,
  isPullRequestVerdictStale,
  isStackedPullRequestBase,
  loadingPullRequestCheckoutCommand,
  pullRequestPanelContext,
  threadPullRequestPanelTarget,
  latestPullRequestReviewOutcomes,
  newestPullRequestCommitAt,
  mergePullRequestThreadComments,
  orderPullRequestComments,
  pullRequestCheckoutCommand,
  checkoutFailureDescription,
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
  resolvePullRequestReferenceHost,
  resolvePullRequestPrimaryControl,
  allowsSinglePullRequestMerge,
  shouldRefreshPullRequestActivity,
  resolveBaseFreshness,
  buildPullRequestTimeline,
  writePullRequestDetailSnapshot,
  readableFailure,
} from "./pullRequestDetail.logic";
import type { ReviewCommentContext } from "~/reviewCommentContext";

const TIMELINE_SOURCE: Pick<
  PullRequestDetailView,
  "provider" | "createdAt" | "author" | "commits" | "comments" | "mergedAt" | "closedAt"
> = {
  provider: SourceControlProviderKind.make("github"),
  createdAt: "2026-07-01T00:00:00Z",
  author: { login: "octocat", name: null, avatarUrl: null },
  commits: [
    { oid: "1baf7bdcafe", messageHeadline: "add the page", committedDate: "2026-07-02T00:00:00Z" },
  ],
  comments: [
    {
      id: "c1",
      kind: "issue-comment",
      author: { login: "bilal", name: null, avatarUrl: null },
      body: "looks good",
      createdAt: "2026-07-03T00:00:00Z",
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  mergedAt: null,
  closedAt: null,
};

describe("pull request checkout commands", () => {
  it("quotes shell metacharacters in Forgejo repository URLs", () => {
    expect(
      pullRequestCheckoutCommand(
        SourceControlProviderKind.make("forgejo"),
        42,
        "feature",
        null,
        "https://forgejo.local/maria/repo'$(echo nope)",
      ),
    ).toBe(
      "git fetch 'https://forgejo.local/maria/repo'\\''$(echo nope)' refs/pull/42/head && git checkout -B pulls/42 FETCH_HEAD",
    );
  });

  const reference = (host?: string): PullRequestRef => ({
    projectId: ProjectId.make("project-1"),
    ...(host === undefined ? {} : { host }),
    repository: "acme/web",
    number: 42,
  });
  const identity = (provider: string, canonicalKey: string): RepositoryIdentity => ({
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/web.git",
    },
    provider: SourceControlProviderKind.make(provider),
  });

  it("uses a matching enterprise identity and rejects an explicit host mismatch", () => {
    const enterprise = identity("github", "github.example.test/acme/web");
    expect(loadingPullRequestCheckoutCommand(reference("github.example.test"), enterprise)).toBe(
      "gh pr checkout 42",
    );
    expect(loadingPullRequestCheckoutCommand(reference("github.com"), enterprise)).toBeNull();
  });

  // regression: #12721 loading layout showed a checkout command guessed from the PR number alone
  it("does not infer a number-only command without a trusted provider", () => {
    expect(loadingPullRequestCheckoutCommand(reference(), undefined)).toBeNull();
    expect(
      loadingPullRequestCheckoutCommand(
        reference("github.com"),
        identity("gitlab", "gitlab.com/acme/web"),
      ),
    ).toBeNull();
  });
});

describe("pull request activity refresh", () => {
  const first = {
    key: "project:acme/web#7",
    updatedAt: "2026-08-13T13:00:00Z",
  };

  it("does not duplicate the first activity read or carry a revision across pull requests", () => {
    expect(shouldRefreshPullRequestActivity(null, first)).toBe(false);
    expect(shouldRefreshPullRequestActivity(first, first)).toBe(false);
    expect(
      shouldRefreshPullRequestActivity(first, {
        key: "project:acme/web#8",
        updatedAt: "2026-08-13T13:01:00Z",
      }),
    ).toBe(false);
  });
});

describe("review thread comment pages", () => {
  it("appends new comments once and keeps refreshed base comments", () => {
    expect(
      mergePullRequestThreadComments(
        [
          { id: "c1", body: "refreshed" },
          { id: "c2", body: "already in base" },
        ],
        [
          { id: "c2", body: "stale page copy" },
          { id: "c3", body: "next page" },
        ],
      ),
    ).toEqual([
      { id: "c1", body: "refreshed" },
      { id: "c2", body: "already in base" },
      { id: "c3", body: "next page" },
    ]);
  });
});

describe("pull request primary control", () => {
  const open = {
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    checksState: "passing" as const,
    autoMergeEnabled: false,
    hasMergeMethod: true,
    canMerge: true,
    canMarkReady: true,
    canEnableAutoMerge: true,
  };

  // regression: #9188 pending/failing checks offered Merge instead of auto-merge
  it("moves pending and failing checks to auto-merge", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, checksState: "pending" })).toBe(
      "enable-auto-merge",
    );
    expect(resolvePullRequestPrimaryControl({ ...open, checksState: "failing" })).toBe(
      "enable-auto-merge",
    );
  });

  it("does not offer auto-merge while the host state is unknown", () => {
    expect(
      resolvePullRequestPrimaryControl({
        ...open,
        checksState: "pending",
        autoMergeEnabled: undefined,
      }),
    ).toBe("merge");
  });
});

describe("stacked pull request classification", () => {
  it("does not mistake a nested branch suffix for the default branch", () => {
    expect(
      isStackedPullRequestBase("main", [
        {
          name: "origin/feature/main",
          isDefault: true,
          isRemote: true,
          remoteName: "origin",
        },
      ]),
    ).toBe(true);
    expect(
      isStackedPullRequestBase("1.0", [{ name: "release/1.0", isDefault: true, isRemote: false }]),
    ).toBe(true);
  });
});

describe("review verdicts", () => {
  it("keeps each reviewer's last word, whatever order the host returned them in", () => {
    const review = (
      id: string,
      login: string,
      reviewState: string,
      createdAt: string,
    ): PullRequestComment => ({
      id,
      kind: "review",
      author: { login, name: null, avatarUrl: null },
      body: "",
      createdAt,
      url: null,
      path: null,
      reviewState,
    });

    expect(
      latestPullRequestReviewOutcomes([
        review("r3", "bilal", "APPROVED", "2026-07-03T00:00:00Z"),
        review("r1", "bilal", "CHANGES_REQUESTED", "2026-07-01T00:00:00Z"),
        review("r2", "octocat", "CHANGES_REQUESTED", "2026-07-02T00:00:00Z"),
        review("r4", "octocat", "COMMENTED", "2026-07-04T00:00:00Z"),
      ]).map((entry) => [entry.actor?.login, entry.outcome]),
    ).toEqual([
      ["bilal", "approved"],
      ["octocat", "changes-requested"],
    ]);
  });

  it("calls a verdict stale once commits land after it, and current before that", () => {
    const commits = [
      { oid: "c0ffee", messageHeadline: "later work", committedDate: "2026-07-05T00:00:00Z" },
    ];
    const review = (createdAt: string): PullRequestComment => ({
      ...TIMELINE_SOURCE.comments[0]!,
      kind: "review",
      reviewState: "APPROVED",
      createdAt,
    });

    expect(
      latestPullRequestReviewOutcomes([review("2026-07-01T00:00:00Z")], commits)[0]?.stale,
    ).toBe(true);
    expect(
      latestPullRequestReviewOutcomes([review("2026-07-06T00:00:00Z")], commits)[0]?.stale,
    ).toBe(false);
    expect(latestPullRequestReviewOutcomes([review("2026-07-01T00:00:00Z")], [])[0]?.stale).toBe(
      false,
    );
  });

  it("orders instants rather than their text, so a UTC offset cannot invert them", () => {
    expect(
      newestPullRequestCommitAt([
        { oid: "a", messageHeadline: "", committedDate: "2026-07-05T00:30:00Z" },
        { oid: "b", messageHeadline: "", committedDate: "2026-07-05T01:00:00+02:00" },
      ]),
    ).toBe("2026-07-05T00:30:00Z");
    expect(isPullRequestVerdictStale("2026-07-05T00:30:00Z", "2026-07-05T01:00:00+02:00")).toBe(
      false,
    );
    expect(isPullRequestVerdictStale("2026-07-01T00:00:00Z", "not a date")).toBe(false);
    expect(
      newestPullRequestCommitAt([{ oid: "a", messageHeadline: "", committedDate: "not a date" }]),
    ).toBeNull();
  });

  it("shows nothing for a reviewer whose verdict was dismissed", () => {
    expect(
      latestPullRequestReviewOutcomes([
        {
          ...TIMELINE_SOURCE.comments[0]!,
          kind: "review",
          reviewState: "APPROVED",
          createdAt: "2026-07-01T00:00:00Z",
        },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "c2",
          kind: "review",
          reviewState: "DISMISSED",
          createdAt: "2026-07-02T00:00:00Z",
        },
      ]),
    ).toEqual([]);
  });
});

describe("pull request timeline", () => {
  it("orders host timestamps by instant across offsets and fractional seconds", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      createdAt: "2026-07-05T01:00:00+02:00",
      commits: [{ oid: "commit", messageHeadline: "", committedDate: "2026-07-05T00:30:00Z" }],
      comments: [{ ...TIMELINE_SOURCE.comments[0]!, createdAt: "2026-07-05T00:30:00.5Z" }],
      mergedAt: null,
      closedAt: null,
    });

    expect(events.map((event) => event.id)).toEqual(["c1", "commit", "created"]);
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

  it("reports a merge rather than the close GitHub records alongside it", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      mergedAt: "2026-07-04T00:00:00Z",
      closedAt: "2026-07-04T00:00:00Z",
    });
    expect(events[0]?.id).toBe("merged");
    expect(events.some((event) => event.id === "closed")).toBe(false);
  });

  it("names the change request in its host's own term", () => {
    const titles = (provider: string) =>
      buildPullRequestTimeline({
        ...TIMELINE_SOURCE,
        provider: SourceControlProviderKind.make(provider),
        closedAt: "2026-07-04T00:00:00Z",
      })
        .filter((event) => event.kind === "opened" || event.kind === "closed")
        .map((event) => event.title);
    expect(titles("github")).toEqual(["Pull request closed", "opened this pull request"]);
    expect(titles("gitlab")).toEqual(["Merge request closed", "opened this merge request"]);
  });

  it("groups conversation sections without crossing commits or PR updates", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      comments: [
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "new-comment-1",
          createdAt: "2026-07-04T00:00:00Z",
        },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "new-comment-2",
          createdAt: "2026-07-03T00:00:00Z",
        },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "old-comment-1",
          createdAt: "2026-07-01T12:00:00Z",
        },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "old-comment-2",
          createdAt: "2026-07-01T06:00:00Z",
        },
      ],
      mergedAt: "2026-07-05T00:00:00Z",
    });

    const rows = groupPullRequestTimelineConversations(events);
    expect(
      rows.map((row) =>
        row.kind === "comments"
          ? [row.kind, ...row.events.map((event) => event.id)]
          : [row.kind, row.event.id],
      ),
    ).toEqual([
      ["event", "merged"],
      ["comments", "new-comment-1", "new-comment-2"],
      ["event", "1baf7bdcafe"],
      ["comments", "old-comment-1", "old-comment-2"],
      ["event", "created"],
    ]);
  });

  it("keeps a verdict out of the collapsed conversation it was submitted in", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      comments: [
        { ...TIMELINE_SOURCE.comments[0]!, id: "chatter-1", createdAt: "2026-07-05T00:00:00Z" },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "approval",
          kind: "review",
          body: "",
          reviewState: "APPROVED",
          createdAt: "2026-07-04T00:00:00Z",
        },
        { ...TIMELINE_SOURCE.comments[0]!, id: "chatter-2", createdAt: "2026-07-03T00:00:00Z" },
        {
          ...TIMELINE_SOURCE.comments[0]!,
          id: "remark",
          kind: "review",
          reviewState: "COMMENTED",
          createdAt: "2026-07-02T12:00:00Z",
        },
      ],
    });

    const rows = groupPullRequestTimelineConversations(events);
    expect(
      rows.map((row) =>
        row.kind === "comments"
          ? [row.kind, ...row.events.map((event) => event.id)]
          : [row.kind, row.event.id],
      ),
    ).toEqual([
      ["comments", "chatter-1"],
      ["event", "approval"],
      ["comments", "chatter-2", "remark"],
      ["event", "1baf7bdcafe"],
      ["event", "created"],
    ]);
  });
});

describe("review thread conversations", () => {
  const bot = { login: "review[bot]", name: null, avatarUrl: null, isBot: true };
  const comment = (id: string, day: number): PullRequestComment => ({
    ...TIMELINE_SOURCE.comments[0]!,
    id,
    kind: "review-comment",
    body: `Current ${id}`,
    createdAt: `2026-07-0${day}T12:00:00Z`,
    url: `https://example.test/pull/1#${id}`,
    path: "src/a.ts",
  });
  const finding = { ...comment("finding", 2), author: bot };
  const reply = {
    ...comment("reply", 4),
    reactions: [
      { content: "thumbs-up" as const, count: 2, actors: ["author"], viewerHasReacted: true },
    ],
  };
  const lastReply = comment("last-reply", 6);
  const loose = TIMELINE_SOURCE.comments[0]!;
  const comments = [finding, loose, reply, lastReply];
  const thread: PullRequestReviewThread = {
    id: "thread",
    path: "src/a.ts",
    line: 7,
    side: "right",
    isResolved: false,
    isOutdated: true,
    comments: [lastReply, { ...finding, body: "Stale finding" }, reply],
  };

  it("keeps a timeline finding and its replies in one row at the finding time", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      comments,
      reviewThreads: [thread],
    });
    expect(events.map((event) => event.id)).toEqual(["c1", "finding", "1baf7bdcafe", "created"]);
    expect(events[1]).toMatchObject({
      id: finding.id,
      at: finding.createdAt,
      body: finding.body,
      url: finding.url,
      thread: {
        path: thread.path,
        line: 7,
        isOutdated: true,
        replies: [
          { id: reply.id, body: reply.body, url: reply.url, reactions: reply.reactions },
          { id: lastReply.id, body: lastReply.body, url: lastReply.url },
        ],
      },
    });
    expect(groupPullRequestTimelineConversations(events).map((row) => row.kind)).toEqual([
      "comments",
      "event",
      "event",
      "event",
    ]);
    expect(events[0]).toEqual(buildPullRequestTimeline(TIMELINE_SOURCE)[0]);
  });

  it("orders and pages whole Summary conversations while retaining editable comment copies", () => {
    const earlier = { ...loose, id: "earlier", createdAt: "2026-07-01T00:00:00Z" };
    const items = pullRequestConversationItems([earlier, ...comments], [thread]);
    expect(orderPullRequestComments(items, "oldest").map((item) => item.id)).toEqual([
      "earlier",
      "thread",
      "c1",
    ]);
    expect(orderPullRequestComments(items, "newest").map((item) => item.id)).toEqual([
      "c1",
      "thread",
      "earlier",
    ]);
    const page = pagePullRequestConversationItems(items, 2);
    expect(page.hidden).toBe(1);
    const grouped = page.shown[0]!;
    expect(grouped.createdAt).toBe(finding.createdAt);
    expect(pullRequestConversationItemComments(grouped)).toEqual([finding, reply, lastReply]);
    expect(pullRequestConversationItemComments(grouped)[0]).toBe(finding);
    expect(pullRequestConversationItemComments(grouped)[1]).toBe(reply);
    expect(pagePullRequestConversationItems(items, 1)).toEqual({ shown: [items[2]], hidden: 2 });
    expect(pullRequestConversationItemComments(items[2]!)).toEqual([loose]);
    expect(pullRequestConversationItems(comments, []).map((item) => item.id)).toEqual(
      comments.map((entry) => entry.id),
    );
  });

  it("filters whole conversations when any member matches, including resolved and dismissed reviews", () => {
    const botOnly = { ...comment("bot-only", 7), author: bot };
    const dismissed = {
      ...comment("dismissed", 8),
      kind: "review" as const,
      reviewState: "DISMISSED",
    };
    const items = pullRequestConversationItems(
      [...comments, botOnly, dismissed],
      [thread, { ...thread, id: "bot-thread", comments: [botOnly] }],
    );
    const kept = filterPullRequestConversationItems(items, { bots: false, resolved: false });
    expect(kept.map((item) => item.id)).toEqual(["thread", "c1"]);
    expect(pullRequestConversationItemComments(kept[0]!)).toEqual([finding, reply, lastReply]);
    expect(filterPullRequestConversationItems(items, { bots: true, resolved: true })).toEqual(
      items,
    );
    const resolved = pullRequestConversationItems(comments, [{ ...thread, isResolved: true }]);
    expect(
      filterPullRequestConversationItems(resolved, { bots: true, resolved: false }).map(
        (item) => item.id,
      ),
    ).toEqual(["c1"]);
    expect(filterPullRequestConversationItems(resolved, { bots: false, resolved: true })).toEqual(
      resolved,
    );
  });

  it("keeps bot review verdicts when bot comments are hidden", () => {
    const review = (id: string, reviewState: string) => ({
      ...comment(id, 9),
      author: bot,
      kind: "review" as const,
      reviewState,
    });
    const items = pullRequestConversationItems(
      [
        review("approved", "APPROVED"),
        review("changes", "CHANGES_REQUESTED"),
        review("commented", "COMMENTED"),
      ],
      [],
    );
    expect(
      filterPullRequestConversationItems(items, { bots: false, resolved: false }).map(
        (item) => item.id,
      ),
    ).toEqual(["approved", "changes"]);
  });

  it("distinguishes unloaded replies from complete threads, even when the host only supplies a cursor", () => {
    const timeline = (reviewThread: PullRequestReviewThread) =>
      buildPullRequestTimeline({
        ...TIMELINE_SOURCE,
        comments,
        reviewThreads: [reviewThread],
      }).find((event) => event.id === finding.id)?.thread;
    expect(timeline({ ...thread, commentCount: 5 })).toMatchObject({
      moreReplies: 2,
      hasMoreReplies: true,
      url: finding.url,
    });
    expect(timeline({ ...thread, nextCommentsCursor: "next" })).toMatchObject({
      moreReplies: 0,
      hasMoreReplies: true,
      url: finding.url,
    });
    expect(timeline(thread)).toMatchObject({ moreReplies: 0, hasMoreReplies: false });
  });
});

describe("fix findings handoff", () => {
  const base = {
    number: 42,
    title: "Add the pull requests page",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    headBranch: "feat/page",
    baseBranch: "main",
    comments: [] as ReadonlyArray<PullRequestComment>,
    commentsTruncated: false,
  };

  function thread(
    body: string,
    overrides: Partial<PullRequestReviewThread> = {},
  ): PullRequestReviewThread {
    return {
      id: "t1",
      path: "apps/web/src/page.tsx",
      line: 12,
      side: "right",
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "tc1",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body,
          createdAt: "2026-07-03T00:00:00Z",
          url: null,
        },
      ],
      ...overrides,
    };
  }

  const failingCheck: PullRequestCheck = {
    name: "typecheck",
    status: "failure",
    description: "2 errors",
    url: null,
  };

  it("attaches a review thread as an annotation instead of quoting it in the prompt", () => {
    const handoff = buildFixFindingsHandoff({
      ...base,
      reviewThreads: [thread("rename the helper")],
      checks: [],
    });
    expect(handoff.reviewComments).toEqual([
      expect.objectContaining({
        filePath: "apps/web/src/page.tsx",
        rangeLabel: "L12",
        startIndex: 11,
        endIndex: 11,
        text: "reviewer: rename the helper",
      }),
    ]);
    expect(handoff.prompt).not.toContain("rename the helper");
    expect(handoff.prompt).toContain("untrusted data");
  });

  it("bounds a hostile review body instead of attaching it whole", () => {
    const handoff = buildFixFindingsHandoff({
      ...base,
      reviewThreads: [thread("x".repeat(5_000))],
      checks: [],
    });
    expect(handoff.reviewComments[0]?.text).toHaveLength(1_000);
    expect(handoff.reviewComments[0]?.text.endsWith("...")).toBe(true);
  });

  it("keeps the newest threads and the failing checks when it has to cut", () => {
    const handoff = buildFixFindingsHandoff({
      ...base,
      reviewThreads: Array.from({ length: 25 }, (_, index) =>
        thread(`finding ${index}`, { id: `t${index}` }),
      ),
      checks: [failingCheck],
    });
    const texts = handoff.reviewComments.map((comment) => comment.text);
    expect(texts).toHaveLength(19);
    expect(texts.at(-1)).toBe("reviewer: finding 24");
    expect(texts).not.toContain("reviewer: finding 0");
    expect(handoff.prompt).toContain("typecheck");
    expect(handoff.prompt).toContain("6 further findings were omitted");
  });

  it("names a GitLab merge request as one", () => {
    const handoff = buildFixFindingsHandoff({
      ...base,
      title: "Add the page",
      url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
      reviewThreads: [],
      checks: [],
    });
    expect(handoff.prompt).toContain("Fix the actionable findings on MR #42");
    expect(handoff.prompt).toContain("The MR branch is `feat/page`");
    expect(handoff.prompt).toContain("inspect the merge request and its failing checks");
    expect(handoff.prompt).not.toMatch(/\bPR\b|pull request/u);
  });
});

describe("findings that cannot be attached", () => {
  const base = {
    number: 42,
    title: "Add the pull requests page",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    headBranch: "feat/page",
    baseBranch: "main",
    reviewThreads: [] as ReadonlyArray<PullRequestReviewThread>,
    checks: [] as ReadonlyArray<PullRequestCheck>,
    commentsTruncated: false,
  };

  const review: PullRequestComment = {
    id: "r1",
    kind: "review",
    author: { login: "julius", name: null, avatarUrl: null },
    body: "This breaks SSO auth, revert the middleware change.",
    createdAt: "2026-07-01T00:00:00Z",
    url: null,
    path: null,
    reviewState: "CHANGES_REQUESTED",
  };

  it("carries a review submitted with words but no line, which has nothing to attach to", () => {
    const handoff = buildFixFindingsHandoff({ ...base, comments: [review] });

    expect(handoff.reviewComments).toEqual([]);
    expect(handoff.prompt).toContain("revert the middleware change");
    expect(handoff.prompt).not.toContain("No unresolved review findings");
  });

  it("does not repeat a remark that was already attached as a thread", () => {
    const attachedId = "t1c1";
    const handoff = buildFixFindingsHandoff({
      ...base,
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
              id: attachedId,
              author: { login: "julius", name: null, avatarUrl: null },
              body: "rename the helper",
              createdAt: "2026-07-01T00:00:00Z",
              url: null,
            },
          ],
        },
      ],
      comments: [{ ...review, id: attachedId, kind: "review-comment", body: "rename the helper" }],
    });

    expect(handoff.reviewComments).toHaveLength(1);
    expect(handoff.prompt).not.toContain("rename the helper");
  });
});

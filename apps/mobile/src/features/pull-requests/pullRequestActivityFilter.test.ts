import { describe, expect, it } from "vite-plus/test";
import { IsoDateTime, type PullRequestActivity, type PullRequestActor } from "@t3tools/contracts";
import { DEFAULT_ACTIVITY_FILTER, filterPullRequestActivity } from "./pullRequestActivityFilter";

const date = IsoDateTime.make("2026-10-11T00:00:00.000Z");
const human: PullRequestActor = { login: "reader", name: null, avatarUrl: null };
const bot: PullRequestActor = { ...human, login: "reviewer[bot]" };
const comment = (id: string, author = human, reviewState: string | null = null) => ({
  id,
  author,
  reviewState,
  kind: "issue-comment" as const,
  body: "A comment",
  createdAt: date,
  url: null,
  path: null,
});
const activity: PullRequestActivity = {
  comments: [
    comment("human"),
    comment("bot", bot),
    comment("dismissed", human, "DISMISSED"),
    comment("reply"),
  ],
  commentCount: 4,
  commentsTruncated: false,
  commits: [{ oid: "abcdef", messageHeadline: "A change", committedDate: date }],
  reviewThreads: [
    {
      id: "thread",
      path: "file.ts",
      line: 1,
      side: "right",
      isResolved: true,
      isOutdated: false,
      comments: [comment("reply")],
    },
  ],
};

describe("mobile activity filters", () => {
  it("keeps the original and bot replies with a human discussion and counts it once", () => {
    const comments = [
      { ...comment("original", bot), threadId: "azure" },
      { ...comment("human"), threadId: "azure", replyToCommentId: "original" },
    ];
    const result = filterPullRequestActivity(
      { ...activity, comments, reviewThreads: [], commits: [] },
      DEFAULT_ACTIVITY_FILTER,
    );
    expect(result.activity.comments.map((entry) => entry.id)).toEqual(["original", "human"]);
    expect(result.hiddenCount).toBe(0);
  });

  it("keeps partially loaded bot discussions visible", () => {
    const thread = {
      ...activity.reviewThreads[0]!,
      isResolved: false,
      comments: [comment("bot-reply", bot)],
    };
    for (const incomplete of [{ commentCount: 2 }, { nextCommentsCursor: "next" }]) {
      const result = filterPullRequestActivity(
        { ...activity, reviewThreads: [{ ...thread, ...incomplete }] },
        DEFAULT_ACTIVITY_FILTER,
      );
      expect(result.activity.reviewThreads).toHaveLength(1);
    }
    expect(
      filterPullRequestActivity({ ...activity, reviewThreads: [thread] }, DEFAULT_ACTIVITY_FILTER)
        .activity.reviewThreads,
    ).toEqual([]);
  });
});

it("hides resolved Azure discussions together and restores them for reactivation", () => {
  for (const threadStatus of [
    "active",
    "pending",
    "fixed",
    "wontFix",
    "closed",
    "byDesign",
  ] as const) {
    const source: PullRequestActivity = {
      ...activity,
      commits: [],
      reviewThreads: [],
      comments: [
        { ...comment("root"), threadId: "azure", threadStatus },
        { ...comment("answer"), threadId: "azure", replyToCommentId: "root", threadStatus },
      ],
    };
    const hidden = !["active", "pending"].includes(threadStatus);
    const filtered = filterPullRequestActivity(source, DEFAULT_ACTIVITY_FILTER);
    expect(filtered.activity.comments).toHaveLength(hidden ? 0 : 2);
    expect(filtered.hiddenCount).toBe(hidden ? 1 : 0);
    expect(
      filterPullRequestActivity(source, { ...DEFAULT_ACTIVITY_FILTER, resolved: true }).activity
        .comments,
    ).toHaveLength(2);
  }
});

it("keeps complete conversations with new replies or edits and filters native activity", () => {
  const newer = IsoDateTime.make("2026-10-13T00:00:00.000Z");
  const result = filterPullRequestActivity(
    {
      ...activity,
      comments: [
        { ...comment("root"), threadId: "general" },
        { ...comment("answer"), threadId: "general", replyToCommentId: "root", editedAt: newer },
        comment("old"),
      ],
      reviewThreads: [
        {
          ...activity.reviewThreads[0]!,
          isResolved: false,
          comments: [comment("inline-root"), { ...comment("inline-reply"), createdAt: newer }],
        },
      ],
      events: [{ id: "vote", actor: human, body: "Approved", createdAt: newer }],
    },
    { ...DEFAULT_ACTIVITY_FILTER, newOnly: true, since: "2026-10-12T00:00:00.000Z" },
  );
  expect(result.activity.comments.map((entry) => entry.id)).toEqual(["root", "answer"]);
  expect(result.activity.reviewThreads[0]?.comments).toHaveLength(2);
  expect(result.activity.commits).toEqual([]);
  expect(result.activity.events).toHaveLength(1);
  expect(result.hiddenCount).toBe(2);
});

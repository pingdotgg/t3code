import { describe, expect, it } from "vite-plus/test";
import { IsoDateTime, type PullRequestActivity, type PullRequestActor } from "@t3tools/contracts";
import { DEFAULT_ACTIVITY_FILTER, filterPullRequestActivity } from "./reviewActivity.ts";

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
  it("hides bots and finished conversations by default, counting each thread once", () => {
    const result = filterPullRequestActivity(activity, DEFAULT_ACTIVITY_FILTER);
    expect(result.activity.comments.map((item) => item.id)).toEqual(["human"]);
    expect(result.activity.reviewThreads).toEqual([]);
    expect(result.activity.commits).toHaveLength(1);
    expect(result.hiddenCount).toBe(3);
  });
  it("restores bot comments and finished conversations without duplicate thread replies", () => {
    const result = filterPullRequestActivity(activity, {
      ...DEFAULT_ACTIVITY_FILTER,
      bots: true,
      resolved: true,
    });
    expect(result.activity.comments.map((item) => item.id)).toEqual(["human", "bot", "dismissed"]);
    expect(result.activity.reviewThreads).toHaveLength(1);
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
  it("provides a commits-only view and a comments-only view", () => {
    const commits = filterPullRequestActivity(activity, {
      ...DEFAULT_ACTIVITY_FILTER,
      kind: "commits",
    }).activity;
    expect(commits.comments).toEqual([]);
    expect(commits.reviewThreads).toEqual([]);
    expect(commits.commits).toHaveLength(1);
    expect(
      filterPullRequestActivity(activity, { ...DEFAULT_ACTIVITY_FILTER, kind: "comments" }).activity
        .commits,
    ).toEqual([]);
  });
});

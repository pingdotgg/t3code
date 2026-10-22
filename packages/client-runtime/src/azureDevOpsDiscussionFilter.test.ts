import { describe, expect, it } from "vite-plus/test";
import type {
  PullRequestActivity,
  PullRequestComment,
  PullRequestThreadStatus,
} from "@t3tools/contracts";
import { filterAzureDevOpsDiscussions } from "./azureDevOpsDiscussionFilter.ts";

const before = "2026-10-15T10:00:00Z";
const since = "2026-10-15T11:00:00Z";
const after = "2026-10-15T12:00:00Z";
function comment(
  id: string,
  threadId: string,
  status: PullRequestThreadStatus,
  login = "other",
): PullRequestComment {
  return {
    id,
    threadId,
    threadStatus: status,
    kind: "issue-comment",
    author: { login, name: null, avatarUrl: null },
    body: id,
    createdAt: before,
    url: null,
    path: null,
    reviewState: null,
  };
}
const activity: PullRequestActivity = {
  comments: [
    comment("a", "active", "active"),
    { ...comment("reply", "active", "active", "VIEWER"), replyToCommentId: "a", editedAt: after },
    comment("r", "fixed", "fixed"),
    comment("w", "wontFix", "wontFix"),
    comment("p", "pending", "pending"),
    comment("b", "bot", "active", "bot[bot]"),
  ],
  commentCount: 6,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  events: [
    { id: "old", actor: null, body: "Opened", createdAt: before },
    { id: "new", actor: null, body: "Pushed", createdAt: after },
  ],
};
const context = { viewer: "viewer", since };

describe("Azure discussion filters", () => {
  it("includes system updates attributed to the viewer in My comments/replies", () => {
    const event = {
      id: "mine",
      actor: { login: "VIEWER", name: null, avatarUrl: null },
      body: "Updated the policy",
      createdAt: before,
    };
    const result = filterAzureDevOpsDiscussions(
      { ...activity, comments: [], events: [event] },
      "mine",
      context,
    );
    expect(result.counts).toMatchObject({ all: 1, comments: 0, mine: 1 });
    expect(result.activity.events).toEqual([event]);
  });
  it("counts whole discussions and includes system updates in everything and new", () => {
    expect(filterAzureDevOpsDiscussions(activity, "all", context).counts).toEqual({
      all: 7,
      comments: 5,
      new: 2,
      mine: 1,
      active: 3,
      resolved: 2,
    });
    expect(filterAzureDevOpsDiscussions(activity, "all", context).activity.events).toHaveLength(2);
    const comments = filterAzureDevOpsDiscussions(activity, "comments", context);
    expect(comments.activity.comments).toHaveLength(6);
    expect(comments.activity.events).toEqual([]);
  });
  it("keeps the original and every reply when the viewer replied or a reply was edited", () => {
    for (const filter of ["mine", "new"] as const) {
      const result = filterAzureDevOpsDiscussions(activity, filter, context);
      expect(result.activity.comments.map((item) => item.id)).toEqual(["a", "reply"]);
      expect(result.activity.events?.map((item) => item.id)).toEqual(
        filter === "new" ? ["new"] : [],
      );
    }
    expect(filterAzureDevOpsDiscussions(activity, "mine", {}).counts.mine).toBe(0);
    expect(filterAzureDevOpsDiscussions(activity, "new", {}).hiddenCount).toBe(0);
  });
  it("includes pending discussions as active, and all terminal states as resolved", () => {
    expect(
      filterAzureDevOpsDiscussions(activity, "active", context).discussions.map(
        (group) => group.comments[0]?.id,
      ),
    ).toEqual(["a", "p", "b"]);
    for (const status of ["fixed", "closed", "wontFix", "byDesign"] as const) {
      const result = filterAzureDevOpsDiscussions(
        { ...activity, comments: [comment("r", "r", status)] },
        "resolved",
        context,
      );
      expect(result.activity.comments).toHaveLength(1);
      expect(result.counts.active).toBe(0);
    }
  });
  it("retains inline threads when a reply matches the filter", () => {
    const root = activity.comments[0]!;
    const reply = activity.comments[1]!;
    const result = filterAzureDevOpsDiscussions(
      {
        ...activity,
        reviewThreads: [
          {
            id: "active",
            path: "test.ts",
            line: 1,
            side: "right",
            isOutdated: false,
            isResolved: false,
            comments: [root, reply],
          },
        ],
      },
      "mine",
      context,
    );
    expect(result.activity.reviewThreads[0]?.comments).toEqual([root, reply]);
    expect(result.counts.mine).toBe(1);
  });
});

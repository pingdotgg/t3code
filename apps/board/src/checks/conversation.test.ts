import type { PullRequestComment, PullRequestReviewThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { audienceCounts, conversationItems, filterByAudience } from "./conversation";

const actor = (login: string, isBot = false) => ({
  login,
  isBot,
  name: null,
  avatarUrl: null,
});

const comment = (
  id: string,
  login: string | null,
  minute: number,
  fields: Partial<PullRequestComment> = {},
): PullRequestComment => ({
  id,
  kind: "issue-comment",
  author: login === null ? null : actor(login, login.endsWith("[bot]")),
  body: `body of ${id}`,
  createdAt: `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`,
  url: null,
  path: null,
  reviewState: null,
  ...fields,
});

const thread = (
  id: string,
  comments: ReadonlyArray<PullRequestComment>,
): PullRequestReviewThread => ({
  id,
  path: "src/app.ts",
  line: 4,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: comments.map(({ id: commentId, author, body, createdAt, url }) => ({
    id: commentId,
    author,
    body,
    createdAt,
    url,
  })),
});

const flat = [
  comment("c1", "vercel[bot]", 1),
  comment("c2", "kyle", 2),
  comment("r1", "coderabbit[bot]", 3, { kind: "review-comment", path: "src/app.ts" }),
  comment("r2", "kyle", 4, { kind: "review-comment", path: "src/app.ts" }),
  comment("c3", "ana", 5),
];
const threads = [thread("t1", [flat[3]!, flat[2]!])];
const activity = { comments: flat, reviewThreads: threads };

describe("a pull request's conversation", () => {
  it("Given comments and a review thread, when listed, then the thread is one item at its first comment's time and its comments are not repeated", () => {
    const items = conversationItems(activity);
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ["comment", "c1"],
      ["comment", "c2"],
      ["thread", "t1"],
      ["comment", "c3"],
    ]);
    const item = items[2];
    expect(
      item?.kind === "thread" && [item.root.id, item.replies.map((reply) => reply.id)],
    ).toEqual(["r1", ["r2"]]);
  });

  it("Given the same conversation, when counted, then a bot's thread and bot comment count as bots", () => {
    expect(audienceCounts(conversationItems(activity))).toEqual({ all: 4, humans: 2, bots: 2 });
  });

  it("Given the conversation, when filtered by humans and by bots, then each keeps its own items", () => {
    const items = conversationItems(activity);
    expect(filterByAudience(items, "humans").map((item) => item.id)).toEqual(["c2", "c3"]);
    expect(filterByAudience(items, "bots").map((item) => item.id)).toEqual(["c1", "t1"]);
    expect(filterByAudience(items, "all")).toHaveLength(4);
  });
});

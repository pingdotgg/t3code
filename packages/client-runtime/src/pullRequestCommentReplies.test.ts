import type { PullRequestComment, PullRequestReviewThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  groupPullRequestComments,
  pullRequestCommentExcerpt,
  pullRequestCommentReplies,
} from "./pullRequestCommentReplies.ts";

describe("groupPullRequestComments", () => {
  it("keeps interleaved Azure threads together, including comments without explicit parents", () => {
    const root = {
      ...comment("17:1", "Question"),
      threadId: "17",
      createdAt: "2026-10-15T01:00:00Z",
    };
    const other = {
      ...comment("18:1", "Unrelated"),
      threadId: "18",
      createdAt: "2026-10-15T02:00:00Z",
    };
    const reply = {
      ...comment("17:2", "Answer"),
      threadId: "17",
      createdAt: "2026-10-15T03:00:00Z",
    };
    for (const comments of [
      [reply, other, root],
      [root, other, reply],
    ]) {
      expect(
        groupPullRequestComments({ comments, reviewThreads: [] }).map((group) => group.threadId),
      ).toEqual(["18", "17"]);
      expect(
        groupPullRequestComments({ comments, reviewThreads: [] }).map((group) =>
          group.comments.map((entry) => entry.body),
        ),
      ).toEqual([["Unrelated"], ["Question", "Answer"]]);
    }
  });

  it("follows nested replies and groups replies whose original is not loaded", () => {
    const comments = [
      comment("root", "Question"),
      comment("answer", "Answer", "root"),
      comment("nested", "Follow-up", "answer"),
      comment("orphan", "Reply", "missing"),
      comment("orphan2", "Another reply", "missing"),
    ];
    expect(
      groupPullRequestComments({ comments, reviewThreads: [] }).map((group) =>
        group.comments.map((entry) => entry.id),
      ),
    ).toEqual([
      ["root", "answer", "nested"],
      ["orphan", "orphan2"],
    ]);
  });

  it("uses review thread membership and keeps unrelated comments separate", () => {
    const comments = [
      comment("root", "Question"),
      comment("other", "Unrelated"),
      comment("reply", "Answer"),
    ];
    const thread: PullRequestReviewThread = {
      id: "review",
      path: "app.ts",
      line: 1,
      side: "right",
      isResolved: false,
      isOutdated: false,
      comments: [comments[0]!, comments[2]!],
    };
    expect(
      groupPullRequestComments({ comments, reviewThreads: [thread] }).map((group) =>
        group.comments.map((entry) => entry.id),
      ),
    ).toEqual([["root", "reply"], ["other"]]);
  });

  it("bounds malformed parent cycles", () => {
    const comments = [
      comment("one", "First", "two"),
      comment("two", "Second", "one"),
      comment("self", "Self", "self"),
    ];
    expect(
      groupPullRequestComments({ comments, reviewThreads: [] }).map((group) =>
        group.comments.map((entry) => entry.id),
      ),
    ).toEqual([["one", "two"], ["self"]]);
  });
});

function comment(id: string, body: string, replyToCommentId?: string): PullRequestComment {
  return {
    id,
    body,
    ...(replyToCommentId === undefined ? {} : { replyToCommentId }),
    kind: "issue-comment",
    author: { login: id, name: null, avatarUrl: null },
    createdAt: "2026-10-15T00:00:00Z",
    path: null,
    url: null,
    reviewState: null,
  };
}

describe("pullRequestCommentReplies", () => {
  it("identifies exact parents, including replies to replies, independently of ordering", () => {
    const comments = [
      comment("root", "Original question"),
      comment("reply", "Answer", "root"),
      comment("nested", "Follow-up", "reply"),
    ];
    for (const ordered of [comments, comments.toReversed()]) {
      const replies = pullRequestCommentReplies({ comments: ordered, reviewThreads: [] });
      expect(replies.has("root")).toBe(false);
      expect(replies.get("reply")).toMatchObject({ author: "root", excerpt: "Original question" });
      expect(replies.get("nested")).toMatchObject({ author: "reply", excerpt: "Answer" });
    }
  });

  it("retains a reply marker when its parent is absent and ignores self-references", () => {
    const replies = pullRequestCommentReplies({
      comments: [comment("reply", "Answer", "missing"), comment("self", "Invalid", "self")],
      reviewThreads: [],
    });
    expect(replies.get("reply")).toMatchObject({
      author: "earlier comment",
      excerpt: "Original comment isn’t loaded.",
    });
    expect(replies.has("self")).toBe(false);
  });

  it("uses review discussions for hosts without explicit parents, preferring an explicit nested parent", () => {
    const root = comment("root", "Question");
    const reply = comment("reply", "Answer");
    const nested = comment("nested", "Follow-up", "reply");
    const thread: PullRequestReviewThread = {
      id: "discussion",
      path: "src/app.ts",
      line: 1,
      side: "right",
      isResolved: true,
      isOutdated: false,
      comments: [root, reply, nested],
    };
    const replies = pullRequestCommentReplies({ comments: [nested], reviewThreads: [thread] });
    expect(replies.has("root")).toBe(false);
    expect(replies.get("reply")).toMatchObject({ author: "root", excerpt: "Question" });
    expect(replies.get("nested")).toMatchObject({ author: "reply", excerpt: "Answer" });
  });

  it("keeps excerpts short and hides bot bookkeeping", () => {
    const replies = pullRequestCommentReplies({
      comments: [
        comment("root", `<!-- hidden -->\n${"word ".repeat(100)}`),
        comment("reply", "Answer", "root"),
      ],
      reviewThreads: [],
    });
    expect(replies.get("reply")?.excerpt).not.toContain("hidden");
    expect(replies.get("reply")?.excerpt).toHaveLength(161);
    expect(replies.get("reply")?.excerpt.endsWith("…")).toBe(true);
  });

  it("reads markup and Markdown as the plain text a preview shows", () => {
    expect(
      pullRequestCommentExcerpt(
        [
          "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
          "## Summary",
          "",
          "> **Note:** keep `Array<string>` and [the docs](https://example.test/docs) ![shot](x.png)",
          "- [x] ~~done~~ in *one* place, not snake_case_name or 2*3*4",
          "<details><summary>More</summary></details>",
          "```suggestion",
          "const value = 1;",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      "Summary Note: keep Array<string> and the docs shot done in one place, not snake_case_name or 2*3*4 More const value = 1;",
    );
    expect(pullRequestCommentExcerpt("<!-- MURMUR_IGNORE -->")).toBe("");
  });

  it("names Azure mentions in previews, keeping the id only for someone it cannot name", () => {
    const named = "AB12CD34-0000-4000-8000-000000000001";
    const unknown = "12345678-0000-4000-8000-000000000002";
    const identities = { [named.toLowerCase()]: "Ada Lovelace" };
    expect(pullRequestCommentExcerpt(`@<${named}> and @<${unknown}> please look`, identities)).toBe(
      `@Ada Lovelace and @${unknown} please look`,
    );
    const replies = pullRequestCommentReplies({
      comments: [comment("root", `@<${named}> can you check?`), comment("reply", "Done", "root")],
      reviewThreads: [],
      identities,
    });
    expect(replies.get("reply")?.excerpt).toBe("@Ada Lovelace can you check?");
  });

  it("leaves unthreaded comments from older servers alone", () => {
    expect(
      pullRequestCommentReplies({
        comments: [comment("one", "First"), comment("two", "Second")],
        reviewThreads: [],
      }).size,
    ).toBe(0);
  });
});

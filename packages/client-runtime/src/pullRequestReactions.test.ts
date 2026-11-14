import {
  SourceControlProviderKind,
  type PullRequestDetail,
  type PullRequestReaction,
  type PullRequestReactionContent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingPullRequestReactions,
  canReactPullRequestComment,
} from "./pullRequestReactions.ts";

function reaction(overrides: Partial<PullRequestReaction> = {}): PullRequestReaction {
  return {
    content: "heart",
    count: 1,
    actors: ["octocat"],
    viewerHasReacted: false,
    ...overrides,
  };
}

describe("comment reaction permissions", () => {
  it("excludes only GitCafe review summaries from comment reactions", () => {
    const detail = {
      provider: SourceControlProviderKind.make("gitcafe"),
      capabilities: {
        diff: true,
        comment: true,
        actions: [],
        mergeMethods: [],
        search: true,
        reactions: true,
        review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
        reviewers: { request: true, listCandidates: true },
      },
    } satisfies Pick<PullRequestDetail, "provider" | "capabilities">;

    expect(canReactPullRequestComment(detail, { kind: "issue-comment" })).toBe(true);
    expect(canReactPullRequestComment(detail, { kind: "review-comment" })).toBe(true);
    expect(
      canReactPullRequestComment(
        { ...detail, provider: SourceControlProviderKind.make("github") },
        { kind: "review" },
      ),
    ).toBe(true);
    expect(canReactPullRequestComment(detail, { kind: "review" })).toBe(false);
  });
});

describe("pending reactions", () => {
  const pending = (
    entries: ReadonlyArray<readonly [PullRequestReactionContent, boolean]>,
  ): ReadonlyMap<PullRequestReactionContent, boolean> => new Map(entries);

  it("adds a reaction nobody had yet, in picker order", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ content: "rocket", count: 2, actors: ["a", "b"] })],
      pending([["thumbs-up", true]]),
    );
    expect(applied).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      { content: "rocket", count: 2, actors: ["a", "b"], viewerHasReacted: false },
    ]);
  });

  it("joins and leaves an existing reaction, and drops the pill nobody is left on", () => {
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"] })],
        pending([["heart", true]]),
      ),
    ).toEqual([{ content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([{ content: "heart", count: 1, actors: ["a", "b"], viewerHasReacted: false }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 1, viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([]);
  });

  it("ignores a pending state the host has already caught up with", () => {
    const reactions = [reaction({ count: 3, viewerHasReacted: true })];
    expect(applyPendingPullRequestReactions(reactions, pending([["heart", true]]))).toEqual(
      reactions,
    );
    expect(applyPendingPullRequestReactions([], pending([["heart", false]]))).toEqual([]);
  });
});

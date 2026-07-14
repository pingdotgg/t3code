import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { decodeGitHubPullRequestReviewJson } from "./gitHubPullRequestReview.ts";

function comment(input: { readonly id: string; readonly login: string; readonly body: string }) {
  return {
    id: input.id,
    author: {
      __typename: "Bot",
      login: input.login,
      avatarUrl: `https://avatars.example/${input.login}`,
    },
    authorAssociation: "CONTRIBUTOR",
    body: input.body,
    url: `https://github.com/SergeSerb2/SergeCode/pull/42#${input.id}`,
    createdAt: "2026-07-13T10:00:00Z",
    updatedAt: "2026-07-13T10:01:00Z",
  };
}

describe("decodeGitHubPullRequestReviewJson", () => {
  it("normalizes bot conversation comments, review summaries, and inline threads", () => {
    const decoded = decodeGitHubPullRequestReviewJson(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 42,
              url: "https://github.com/SergeSerb2/SergeCode/pull/42",
              comments: {
                nodes: [comment({ id: "issue-1", login: "coderabbitai", body: "Walkthrough" })],
                pageInfo: { hasNextPage: false },
              },
              reviews: {
                nodes: [
                  {
                    ...comment({ id: "review-1", login: "coderabbitai", body: "Actionable: 1" }),
                    state: "COMMENTED",
                  },
                  {
                    ...comment({ id: "review-empty", login: "octocat", body: "  " }),
                    state: "APPROVED",
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-1",
                    isResolved: false,
                    isOutdated: false,
                    path: "apps/mobile/src/App.tsx",
                    line: 27,
                    originalLine: 25,
                    diffSide: "RIGHT",
                    comments: {
                      nodes: [
                        comment({
                          id: "inline-1",
                          login: "coderabbitai[bot]",
                          body: "Guard this failure path.",
                        }),
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.provider).toBe("github");
    expect(decoded.success.comments[0]?.author).toEqual({
      login: "coderabbitai",
      avatarUrl: "https://avatars.example/coderabbitai",
      isBot: true,
    });
    expect(decoded.success.reviews).toHaveLength(1);
    expect(decoded.success.threads[0]).toMatchObject({
      id: "thread-1",
      isResolved: false,
      isOutdated: false,
      path: "apps/mobile/src/App.tsx",
      line: 27,
      originalLine: 25,
      diffSide: "RIGHT",
    });
    expect(decoded.success.threads[0]?.comments[0]?.author.isBot).toBe(true);
    expect(decoded.success.unresolvedThreadCount).toBe(1);
    expect(decoded.success.truncated).toBe(false);
    expect(DateTime.formatIso(decoded.success.comments[0]!.createdAt)).toBe(
      "2026-07-13T10:00:00.000Z",
    );
  });

  it("marks the snapshot truncated when a nested thread has more replies", () => {
    const decoded = decodeGitHubPullRequestReviewJson(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 42,
              url: "https://github.com/SergeSerb2/SergeCode/pull/42",
              comments: { nodes: [], pageInfo: { hasNextPage: false } },
              reviews: { nodes: [], pageInfo: { hasNextPage: false } },
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-1",
                    isResolved: true,
                    isOutdated: true,
                    path: "README.md",
                    line: null,
                    originalLine: null,
                    diffSide: null,
                    comments: { nodes: [], pageInfo: { hasNextPage: true } },
                  },
                  {
                    id: "thread-2",
                    isResolved: false,
                    isOutdated: true,
                    path: "README.md",
                    line: null,
                    originalLine: null,
                    diffSide: null,
                    comments: { nodes: [], pageInfo: { hasNextPage: false } },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.truncated).toBe(true);
    expect(decoded.success.unresolvedThreadCount).toBe(0);
  });
});

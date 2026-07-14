import { describe, expect, it } from "@effect/vitest";

import {
  deriveReviewLifecycle,
  parsePullRequestReviewStatus,
} from "./pullRequestReviewLifecycle.ts";

const REVIEWING_COMMENT =
  "> [!NOTE]\n> Currently processing new changes in this PR. This may take a few minutes, please wait...";

function payload(input: {
  readonly threads?: ReadonlyArray<{ isResolved: boolean }> | null;
  readonly hasNextPage?: boolean;
  readonly reviews?: ReadonlyArray<{ state: string }>;
  readonly firstComments?: ReadonlyArray<{ login: string; body: string }>;
  readonly latestComments?: ReadonlyArray<{ login: string; body: string }>;
}) {
  const toComments = (comments: ReadonlyArray<{ login: string; body: string }> | undefined) => ({
    nodes: (comments ?? []).map((comment) => ({
      author: { login: comment.login },
      body: comment.body,
    })),
  });
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: input.threads ?? [],
            pageInfo: { hasNextPage: input.hasNextPage ?? false },
          },
          reviews: { nodes: (input.reviews ?? []).map((review) => ({ state: review.state })) },
          firstComments: toComments(input.firstComments),
          latestComments: toComments(input.latestComments),
        },
      },
    },
  });
}

describe("deriveReviewLifecycle", () => {
  it("reports review-in-progress while the bot says it is still processing", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: 0,
        hasSubmittedReview: true,
        comments: [{ login: "coderabbitai[bot]", body: REVIEWING_COMMENT }],
      }),
    ).toBe("review-in-progress");
  });

  it("prefers in-progress over unresolved threads left from the previous pass", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: 3,
        hasSubmittedReview: true,
        comments: [{ login: "coderabbitai", body: REVIEWING_COMMENT }],
      }),
    ).toBe("review-in-progress");
  });

  it("ignores in-progress wording from a human author", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: 0,
        hasSubmittedReview: true,
        comments: [{ login: "serge", body: "review in progress, hold off merging" }],
      }),
    ).toBe("review-complete");
  });

  it("reports actionable-comments while threads are unresolved", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: 2,
        hasSubmittedReview: true,
        comments: [{ login: "coderabbitai[bot]", body: "**Actionable comments posted: 2**" }],
      }),
    ).toBe("actionable-comments");
  });

  it("reports review-complete once a review landed and nothing is unresolved", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: 0,
        hasSubmittedReview: true,
        comments: [{ login: "coderabbitai[bot]", body: "**Actionable comments posted: 0**" }],
      }),
    ).toBe("review-complete");
  });

  it("stays unknown when nobody has reviewed yet", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: 0,
        hasSubmittedReview: false,
        comments: [],
      }),
    ).toBeNull();
  });

  it("stays unknown when the thread count is unavailable", () => {
    expect(
      deriveReviewLifecycle({
        unresolvedReviewThreadCount: null,
        hasSubmittedReview: true,
        comments: [],
      }),
    ).toBeNull();
  });
});

describe("parsePullRequestReviewStatus", () => {
  it("counts unresolved threads and derives the lifecycle from the bot summary comment", () => {
    expect(
      parsePullRequestReviewStatus(
        payload({
          threads: [{ isResolved: false }, { isResolved: true }],
          reviews: [{ state: "COMMENTED" }],
          firstComments: [{ login: "coderabbitai[bot]", body: "Walkthrough" }],
        }),
      ),
    ).toEqual({ unresolvedReviewThreadCount: 1, reviewLifecycle: "actionable-comments" });
  });

  it("sees the in-progress marker on the bot's edited summary comment", () => {
    expect(
      parsePullRequestReviewStatus(
        payload({
          threads: [],
          reviews: [{ state: "COMMENTED" }],
          firstComments: [{ login: "coderabbitai[bot]", body: REVIEWING_COMMENT }],
          latestComments: [{ login: "serge", body: "thanks" }],
        }),
      ),
    ).toEqual({ unresolvedReviewThreadCount: 0, reviewLifecycle: "review-in-progress" });
  });

  it("reports a clean finished review", () => {
    expect(
      parsePullRequestReviewStatus(
        payload({
          threads: [{ isResolved: true }],
          reviews: [{ state: "APPROVED" }],
          firstComments: [{ login: "coderabbitai[bot]", body: "Walkthrough" }],
        }),
      ),
    ).toEqual({ unresolvedReviewThreadCount: 0, reviewLifecycle: "review-complete" });
  });

  it("treats an unfinished thread page as an unknown count and unknown lifecycle", () => {
    expect(
      parsePullRequestReviewStatus(
        payload({
          threads: [{ isResolved: true }],
          hasNextPage: true,
          reviews: [{ state: "APPROVED" }],
        }),
      ),
    ).toEqual({ unresolvedReviewThreadCount: null, reviewLifecycle: null });
  });

  it("degrades to unknown on a payload it cannot read", () => {
    expect(parsePullRequestReviewStatus("not json")).toEqual({
      unresolvedReviewThreadCount: null,
      reviewLifecycle: null,
    });
    expect(parsePullRequestReviewStatus("{}")).toEqual({
      unresolvedReviewThreadCount: null,
      reviewLifecycle: null,
    });
  });

  it("stays backward compatible with a payload that only carries review threads", () => {
    expect(
      parsePullRequestReviewStatus(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } },
            },
          },
        }),
      ),
    ).toEqual({ unresolvedReviewThreadCount: 1, reviewLifecycle: "actionable-comments" });
  });
});

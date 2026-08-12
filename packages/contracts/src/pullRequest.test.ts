import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS,
  PullRequestSubmitReviewInput,
} from "./pullRequest.ts";

const decodeSubmitReview = Schema.decodeUnknownSync(PullRequestSubmitReviewInput);

function reviewComments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    line: 1,
    side: "right",
    body: "Please revise this.",
  }));
}

describe("PullRequestSubmitReviewInput", () => {
  it("accepts at most ten bounded inline comments", () => {
    const input = {
      projectId: "project-1",
      repository: "acme/web",
      number: 42,
      verdict: "comment",
      body: "",
    };

    expect(
      decodeSubmitReview({
        ...input,
        comments: reviewComments(MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS),
      }).comments,
    ).toHaveLength(MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS);
    expect(() =>
      decodeSubmitReview({
        ...input,
        comments: reviewComments(MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS + 1),
      }),
    ).toThrow();
  });
});

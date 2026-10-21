import { describe, expect, it } from "vite-plus/test";
import {
  clearSubmittedReview,
  pullRequestReviewKey,
  type ReviewDraft,
} from "./pullRequestReviewDrafts";
const comment = {
  id: "one",
  path: "renamed.ts",
  oldPath: "old.ts",
  position: { kind: "deleted" as const, oldLine: 9 },
  body: "Keep this",
  headSha: "abc",
  code: "old line",
};
const draft: ReviewDraft = {
  summary: "Review",
  comment: "Separate PR comment",
  comments: [comment],
};
describe("mobile review draft recovery", () => {
  it("clears a submitted snapshot while retaining edits made during the request", () => {
    const current = {
      ...draft,
      summary: "New summary",
      comments: [
        { ...comment, body: "New feedback" },
        { ...comment, id: "two" },
      ],
    };
    expect(clearSubmittedReview(current, draft)).toEqual(current);
    expect(clearSubmittedReview(draft, draft)).toEqual({
      summary: "",
      comment: draft.comment,
      comments: [],
    });
  });
  it("does not mix identical PR numbers across repositories, hosts, or environments", () => {
    const ref = {
      environmentId: "a",
      projectId: "p",
      host: "github.com",
      repository: "one/repo",
      number: 1,
    };
    expect(
      new Set(
        [
          ref,
          { ...ref, environmentId: "b" },
          { ...ref, host: "github.enterprise" },
          { ...ref, repository: "two/repo" },
        ].map(pullRequestReviewKey),
      ).size,
    ).toBe(4);
  });
});

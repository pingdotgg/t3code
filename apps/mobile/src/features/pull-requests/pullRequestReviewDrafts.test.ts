import { describe, expect, it } from "vite-plus/test";
import {
  clearSubmittedReview,
  reviewDraftReplacement,
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

  it("keeps replacing an outdated draft until it is moved to the current head", () => {
    expect(reviewDraftReplacement(draft, null, "one")).toStrictEqual({});
    expect(reviewDraftReplacement(draft, "def", "one")).toStrictEqual({ draftId: "one" });
    expect(reviewDraftReplacement(draft, "abc", "one")).toStrictEqual({
      resetOnReload: { replacingDraftId: undefined },
    });
  });
});

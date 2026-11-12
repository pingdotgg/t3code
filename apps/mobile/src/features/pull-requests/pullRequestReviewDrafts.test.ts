import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  clearSubmittedReview,
  ReviewDraftDocument,
  type ReviewDraft,
} from "./pullRequestReviewDrafts";
const decodeDocument = Schema.decodeUnknownSync(ReviewDraftDocument);
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
  it("recovers a line range and keeps a range changed while submission was in flight", () => {
    const ranged = {
      ...draft,
      comments: [
        {
          ...comment,
          position: { kind: "added" as const, newLine: 12 },
          startPosition: { kind: "added" as const, newLine: 9 },
        },
      ],
    };
    const recovered = decodeDocument(
      JSON.parse(JSON.stringify({ version: 1, drafts: { key: ranged } })),
    ).drafts.key!;
    expect(recovered).toEqual(ranged);
    const updated = {
      ...recovered,
      comments: recovered.comments.map((entry) => ({
        ...entry,
        startPosition: { kind: "added" as const, newLine: 10 },
      })),
    };
    expect(clearSubmittedReview(updated, recovered).comments).toEqual(updated.comments);
    expect(clearSubmittedReview(recovered, recovered).comments).toEqual([]);
  });

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
});

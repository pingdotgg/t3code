import { describe, expect, it } from "vite-plus/test";

import { getQuestionAnswerPreview, getQuestionAnswerText } from "./userInput.js";

// Shape the web client submits for an answer holding a review-comment chip.
const answerWithReviewComment = [
  "See my note: [Review comment: notes.md L2; ref=review-comment_c1]",
  "",
  '<t3_context version="1">',
  '<context kind="review-comment" id="review-comment_c1">',
  "file: notes.md",
  "range: L2 (2-2)",
  "comment:",
  "  Rename this",
  "diff:",
  "  +line changed",
  "</context>",
  "</t3_context>",
].join("\n");

describe("question answer display", () => {
  it("keeps the provider context envelope out of answer history and preview", () => {
    const history = getQuestionAnswerText(answerWithReviewComment);
    const preview = getQuestionAnswerPreview({
      requestId: "request-1",
      answers: { q1: answerWithReviewComment },
      attachmentsByQuestionId: {},
      questionTextById: { q1: "What should change?" },
    });

    expect(history).toBe("See my note: [Review comment: notes.md L2]");
    expect(preview).toContain("See my note:");
    expect(preview).not.toContain("<t3_context");

    const typedXml =
      'Use this XML literally: <t3_context version="1"><context kind="review-comment" id="example">keep me</context></t3_context>';
    expect(getQuestionAnswerText(typedXml)).toBe(typedXml);
  });
});

import { describe, expect, it } from "vitest";

import { extractReviewOutputJson, isReviewOutputText } from "./reviewOutput.ts";

const reviewOutput = JSON.stringify({
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: "No issues.",
  overall_confidence_score: 0.9,
});

describe("extractReviewOutputJson", () => {
  it("recovers a single review object wrapped in prose", () => {
    expect(extractReviewOutputJson(`Here you go:\n${reviewOutput}\nDone.`)).toMatchObject({
      status: "decoded",
    });
  });

  it("rejects output without JSON and output with several objects", () => {
    expect(extractReviewOutputJson("no json here")).toMatchObject({ status: "invalid" });
    expect(extractReviewOutputJson(`${reviewOutput}\n${reviewOutput}`)).toMatchObject({
      status: "invalid",
    });
  });
});

describe("isReviewOutputText", () => {
  it("detects reviewer output and ignores ordinary replies", () => {
    expect(isReviewOutputText(reviewOutput)).toBe(true);
    expect(isReviewOutputText(`Prose around ${reviewOutput}`)).toBe(true);
    expect(isReviewOutputText("I fixed the merge conflicts.")).toBe(false);
    expect(isReviewOutputText(JSON.stringify({ findings: [] }))).toBe(false);
  });
});

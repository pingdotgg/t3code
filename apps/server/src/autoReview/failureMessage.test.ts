import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { describeAutoReviewFailure } from "./failureMessage.ts";

class StructuredError extends Error {
  readonly detail = "GitHub CLI is not authenticated. Run `gh auth login` and retry.";

  constructor() {
    super("GitHub CLI failed in execute: authentication");
  }
}

describe("describeAutoReviewFailure", () => {
  it("keeps the actionable detail on one line", () => {
    const message = describeAutoReviewFailure(Cause.fail(new StructuredError()));
    expect(message).toContain("gh auth login");
    expect(message).not.toContain("\n");
  });

  it("falls back to the error message when there is no detail", () => {
    const message = describeAutoReviewFailure(Cause.fail(new Error("Grok ACP request timed out.")));
    expect(message).toBe("Grok ACP request timed out.");
  });

  it("caps runaway messages", () => {
    const message = describeAutoReviewFailure(Cause.fail(new Error("x".repeat(2_000))));
    expect(message.length).toBeLessThanOrEqual(400);
    expect(message.endsWith("…")).toBe(true);
  });

  it("describes an empty cause instead of returning a blank string", () => {
    expect(describeAutoReviewFailure(Cause.fail(new Error("")))).toBe(
      "Auto-review failed for an unknown reason.",
    );
  });
});

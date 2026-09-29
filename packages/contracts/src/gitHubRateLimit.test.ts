import { describe, expect, it } from "vitest";

import {
  GITHUB_RATE_LIMIT_MARKER,
  isGitHubRateLimitMessage,
  rewriteGitHubRateLimitDetail,
} from "./gitHubRateLimit.ts";

describe("gitHubRateLimit", () => {
  it("detects the primary rate-limit refusal inside a full gh failure", () => {
    expect(
      isGitHubRateLimitMessage(
        "gh api graphql --hostname github.com failed (code=1, signal=null). " +
          "gh: API rate limit already exceeded for user ID 23518228.",
      ),
    ).toBe(true);
  });

  it("detects secondary rate limits", () => {
    expect(
      isGitHubRateLimitMessage("gh: You have exceeded a secondary rate limit. Try again later."),
    ).toBe(true);
  });

  it("leaves ordinary failures alone", () => {
    expect(isGitHubRateLimitMessage("gh: Not Found (HTTP 404)")).toBe(false);
    expect(
      isGitHubRateLimitMessage("GitHub CLI is not authenticated. Run `gh auth login` and retry."),
    ).toBe(false);
    expect(isGitHubRateLimitMessage("Pull request not found.")).toBe(false);
  });

  it("rewrites a rate-limit detail to the stable friendly sentence", () => {
    const rewritten = rewriteGitHubRateLimitDetail(
      "GitHub CLI command failed: gh: API rate limit already exceeded for user ID 1.",
    );
    expect(rewritten.startsWith(GITHUB_RATE_LIMIT_MARKER)).toBe(true);
    expect(rewritten).toContain("within the hour");
  });

  it("passes non-rate-limit details through unchanged", () => {
    const detail = "GitHub CLI command failed: gh: Not Found (HTTP 404)";
    expect(rewriteGitHubRateLimitDetail(detail)).toBe(detail);
  });
});

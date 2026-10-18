import { describe, expect, it } from "vite-plus/test";

import { describePullRequestDiffError } from "./pullRequestDiffError";

describe("describePullRequestDiffError", () => {
  it("explains the rate limit inside an HTTP transport error without exposing the endpoint", () => {
    const error =
      "Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests to github.com are paused until the rate limit resets.).";
    const result = describePullRequestDiffError(error, "GitHub");

    expect(result.title).toBe("GitHub rate limit reached");
    expect(result.description).toContain("after the limit resets");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("PullRequestOperationError");
  });

  it("recognizes a provider's API quota error", () => {
    expect(describePullRequestDiffError("GitHub API rate limit exceeded.", "GitHub").title).toBe(
      "GitHub rate limit reached",
    );
  });

  it("uses the actual host's name for a rate limit", () => {
    const result = describePullRequestDiffError("Too many requests", "GitLab");

    expect(result.title).toBe("GitLab rate limit reached");
    expect(result.description).toContain("on GitLab");
    expect(result.description).not.toContain("GitHub");
  });

  it("does not blame a rate limit for an unknown connection failure", () => {
    const result = describePullRequestDiffError(
      "Failed to fetch remote environment endpoint http://localhost:49477/api/pull-requests/diff (TypeError: Failed to fetch).",
      "GitHub",
    );

    expect(result.title).toBe("Couldn't load the changes");
    expect(result.description).toContain("Try again");
    expect(result.description).not.toContain("localhost");
    expect(result.description).not.toContain("limit");
  });
});

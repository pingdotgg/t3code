import { describe, expect, it, vi } from "vite-plus/test";

import {
  describePullRequestDiffError,
  describeSourceControlRateLimitError,
} from "./pullRequestDiffError";

describe("describePullRequestDiffError", () => {
  it("explains the rate limit inside an HTTP transport error without exposing the endpoint", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-07T12:00:00.000Z"));
    const error =
      "Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests to github.com are paused by a rate limit. Requests resume at 2026-11-07T18:00:00.000Z.).";
    const result = describePullRequestDiffError(error, "GitHub", "pull request");

    expect(result.title).toBe("GitHub rate limit reached");
    expect(result.description).toContain("Try again");
    expect(result.description).toContain("temporarily limiting requests");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("PullRequestOperationError");
  });

  // regression: #19945 diff load failures from a provider quota showed a generic error
  it("recognizes a provider's API quota error", () => {
    expect(
      describePullRequestDiffError("GitHub API rate limit exceeded.", "GitHub", "pull request")
        .title,
    ).toBe("GitHub rate limit reached");
  });

  it("includes the resume time in the muted subtitle copy", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-07T12:00:00.000Z"));
    const result = describePullRequestDiffError(
      "GitHub API rate limit exceeded. Requests resume at 2026-11-07T18:00:00.000Z.",
      "GitHub",
      "pull request",
      "12-hour",
    );

    expect(result.description).toMatch(/Try again at .+, or view the changes on GitHub\.$/);
    expect(result.description).toContain("temporarily limiting requests");
    expect(result.description).not.toContain("after the limit resets");
  });

  it("does not blame a rate limit for an unknown connection failure", () => {
    const result = describePullRequestDiffError(
      "Failed to fetch remote environment endpoint http://localhost:49477/api/pull-requests/diff (TypeError: Failed to fetch).",
      "GitHub",
      "pull request",
    );

    expect(result.title).toBe("Couldn't load the changes");
    expect(result.description).toContain("Try again");
    expect(result.description).not.toContain("localhost");
    expect(result.description).not.toContain("limit");
  });
});

describe("describeSourceControlRateLimitError", () => {
  it("puts a local resume time on rate-limit detail", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-07T12:00:00.000Z"));
    expect(
      describeSourceControlRateLimitError(
        "GitHub API rate limit exceeded. Requests resume at 2026-11-07T18:00:00.000Z.",
        "12-hour",
      ),
    ).toMatch(/^GitHub API rate limit exceeded\. Resumes .+\.$/);
  });

  it("leaves unrelated errors alone", () => {
    expect(describeSourceControlRateLimitError("Repository not found.", "12-hour")).toBe(
      "Repository not found.",
    );
  });
});

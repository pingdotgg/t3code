import { describe, expect, it, vi } from "vite-plus/test";

import { formatUpcomingTimestamp } from "../../timestampFormat";
import {
  describePullRequestDiffError,
  describeSourceControlRateLimitError,
} from "./pullRequestDiffError";

describe("describePullRequestDiffError", () => {
  it("explains the rate limit inside an HTTP transport error without exposing the endpoint", () => {
    const nowMs = Date.parse("2026-11-07T12:00:00.000Z");
    using _now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const resumeAt = "2026-11-07T18:00:00.000Z";
    const when = formatUpcomingTimestamp(resumeAt, "12-hour", nowMs);
    const error = `Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests to github.com are paused by a rate limit. Requests resume at ${resumeAt}.).`;
    const result = describePullRequestDiffError(error, "GitHub", "pull request");

    expect(result.title).toBe("GitHub rate limit reached");
    expect(result.description).toContain(`Try again at ${when}`);
    expect(result.description).toContain("temporarily limiting requests");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("PullRequestOperationError");
  });

  // regression: #19945 diff load failures from a provider quota showed a generic error
  it("recognizes a provider's API quota error, with or without a resume time", () => {
    const nowMs = Date.parse("2026-11-07T12:00:00.000Z");
    using _now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    expect(
      describePullRequestDiffError("GitHub API rate limit exceeded.", "GitHub", "pull request")
        .title,
    ).toBe("GitHub rate limit reached");

    const resumeAt = "2026-11-07T18:00:00.000Z";
    const when = formatUpcomingTimestamp(resumeAt, "12-hour", nowMs);
    expect(
      describePullRequestDiffError(
        `GitHub API rate limit exceeded. Requests resume at ${resumeAt}.`,
        "GitHub",
        "pull request",
        "12-hour",
        nowMs,
      ).description,
    ).toBe(
      `GitHub is temporarily limiting requests, so this diff couldn't be loaded. Try again at ${when}, or view the changes on GitHub.`,
    );
  });

  it("drops a past resume time for immediate retry copy", () => {
    const nowMs = Date.parse("2026-11-07T19:00:00.000Z");
    expect(
      describePullRequestDiffError(
        "GitHub API rate limit exceeded. Requests resume at 2026-11-07T18:00:00.000Z.",
        "GitHub",
        "pull request",
        "12-hour",
        nowMs,
      ).description,
    ).toBe(
      "GitHub is temporarily limiting requests, so this diff couldn't be loaded. Try again, or view the changes on GitHub.",
    );
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
    const nowMs = Date.parse("2026-11-07T12:00:00.000Z");
    using _now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const resumeAt = "2026-11-07T18:00:00.000Z";
    const when = formatUpcomingTimestamp(resumeAt, "12-hour", nowMs);
    expect(
      describeSourceControlRateLimitError(
        `GitHub API rate limit exceeded. Requests resume at ${resumeAt}.`,
        "12-hour",
        nowMs,
      ),
    ).toBe(`GitHub API rate limit exceeded. Resumes ${when}.`);
  });

  it("omits a past resume time from rate-limit detail", () => {
    expect(
      describeSourceControlRateLimitError(
        "GitHub API rate limit exceeded. Requests resume at 2026-11-07T18:00:00.000Z.",
        "12-hour",
        Date.parse("2026-11-07T19:00:00.000Z"),
      ),
    ).toBe("GitHub API rate limit exceeded");
  });

  it("leaves unrelated errors alone", () => {
    expect(describeSourceControlRateLimitError("Repository not found.", "12-hour")).toBe(
      "Repository not found.",
    );
  });
});

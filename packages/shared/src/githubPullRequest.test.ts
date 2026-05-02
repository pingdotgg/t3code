import { describe, expect, it } from "vitest";

import {
  buildGitHubPullRequestUrl,
  normalizeGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
} from "./githubPullRequest.ts";

describe("parseGitHubPullRequestUrl", () => {
  it("parses canonical GitHub pull request URLs", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/openai/codex/pull/54")).toEqual({
      owner: "openai",
      repo: "codex",
      number: "54",
    });
  });

  it("accepts GitHub pull request URLs with suffixes and Slack wrappers", () => {
    expect(
      parseGitHubPullRequestUrl("<https://github.com/openai/codex/pull/54/files|codex#54>"),
    ).toEqual({
      owner: "openai",
      repo: "codex",
      number: "54",
    });
  });

  it("returns null for non-pull-request GitHub URLs", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/openai/codex/issues/54")).toBeNull();
  });
});

describe("buildGitHubPullRequestUrl", () => {
  it("builds the canonical pull request URL", () => {
    expect(
      buildGitHubPullRequestUrl({
        owner: "openai",
        repo: "codex",
        number: "54",
      }),
    ).toBe("https://github.com/openai/codex/pull/54");
  });
});

describe("normalizeGitHubPullRequestUrl", () => {
  it("normalizes suffixed pull request URLs to the canonical form", () => {
    expect(
      normalizeGitHubPullRequestUrl("https://github.com/openai/codex/pull/54/files#diff-123"),
    ).toBe("https://github.com/openai/codex/pull/54");
  });

  it("returns null for inputs that are not pull request URLs", () => {
    expect(normalizeGitHubPullRequestUrl("https://github.com/openai/codex")).toBeNull();
  });
});

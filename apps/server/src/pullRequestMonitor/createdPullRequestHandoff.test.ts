import { describe, expect, it } from "vitest";

import { buildCreatedPullRequestLink } from "./createdPullRequestHandoff.ts";

const basePr = {
  status: "created" as const,
  url: "https://github.com/owner/repo/pull/42",
  number: 42,
  title: "Add feature",
  baseBranch: "main",
  headBranch: "feature",
};

describe("buildCreatedPullRequestLink", () => {
  it("builds a created link only for a confirmed create result", () => {
    const link = buildCreatedPullRequestLink(basePr);
    expect(link?.source).toBe("created");
    expect(link?.pullRequest.number).toBe(42);
    expect(link?.pullRequest.url).toBe("https://github.com/owner/repo/pull/42");
    expect(link?.pullRequest.state).toBe("open");
  });

  it("rejects opened_existing results so re-opens never look like creations", () => {
    expect(
      buildCreatedPullRequestLink({ ...basePr, status: "opened_existing" as const }),
    ).toBeNull();
  });

  it("rejects skipped results", () => {
    expect(buildCreatedPullRequestLink({ status: "skipped_not_requested" as const })).toBeNull();
  });

  it("rejects created results without a durable number/url", () => {
    expect(buildCreatedPullRequestLink({ ...basePr, number: undefined })).toBeNull();
    expect(buildCreatedPullRequestLink({ ...basePr, url: undefined })).toBeNull();
    expect(buildCreatedPullRequestLink({ ...basePr, url: "  " })).toBeNull();
  });

  it("rejects created results whose URL has no repository identity", () => {
    expect(
      buildCreatedPullRequestLink({ ...basePr, url: "https://github.com/owner/pull/42" }),
    ).toBeNull();
  });

  it("falls back to a usable head branch and title", () => {
    const link = buildCreatedPullRequestLink({
      ...basePr,
      title: undefined,
      headBranch: undefined,
      pushBranch: "feature",
    });
    expect(link?.pullRequest.headBranch).toBe("feature");
    expect(link?.pullRequest.title).toBe("Pull request #42");
  });
});

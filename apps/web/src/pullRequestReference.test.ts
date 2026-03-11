import { describe, expect, it } from "vitest";

import { parsePullRequestReference } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(parsePullRequestReference("https://github.com/pingdotgg/t3code/pull/42")).toBe(
      "https://github.com/pingdotgg/t3code/pull/42",
    );
  });

  it("accepts raw numbers", () => {
    expect(parsePullRequestReference("42")).toBe("42");
  });

  it("accepts #number references", () => {
    expect(parsePullRequestReference("#42")).toBe("#42");
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });

  it("accepts GitLab merge request URLs", () => {
    expect(parsePullRequestReference("https://gitlab.com/group/project/-/merge_requests/42")).toBe(
      "https://gitlab.com/group/project/-/merge_requests/42",
    );
  });

  it("accepts GitLab merge request URLs with subgroups", () => {
    expect(
      parsePullRequestReference("https://gitlab.com/org/sub/project/-/merge_requests/99"),
    ).toBe("https://gitlab.com/org/sub/project/-/merge_requests/99");
  });

  it("accepts self-hosted GitLab merge request URLs", () => {
    expect(
      parsePullRequestReference("https://gitlab.example.com/team/repo/-/merge_requests/7"),
    ).toBe("https://gitlab.example.com/team/repo/-/merge_requests/7");
  });
});

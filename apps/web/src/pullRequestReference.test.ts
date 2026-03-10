import { describe, expect, it } from "vitest";

import { parsePullRequestReference } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(
      parsePullRequestReference("https://github.com/pingdotgg/t3code/pull/42"),
    ).toBe("https://github.com/pingdotgg/t3code/pull/42");
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
});

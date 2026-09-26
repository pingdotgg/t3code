import { describe, expect, it } from "vite-plus/test";

import { gitHubRepositoryOf, issueNumberFromBranch, parseIssueUrl } from "./issueLinks.ts";

describe("issueNumberFromBranch", () => {
  it("reads task branches <type>/<number>-<slug>", () => {
    expect(issueNumberFromBranch("feat/28-issue-links")).toBe(28);
    expect(issueNumberFromBranch("fix/7-a.b_c")).toBe(7);
    expect(issueNumberFromBranch("Chore/12-Tidy")).toBe(12);
  });
  it("ignores branches that name no Issue", () => {
    for (const branch of [
      null,
      "main",
      "feat/issue-28",
      "28-issue",
      "a/b/28-x",
      "feat/28",
      "feat/0-x",
    ]) {
      expect(issueNumberFromBranch(branch)).toBeNull();
    }
  });
});

describe("parseIssueUrl", () => {
  it("normalizes host and repository", () => {
    expect(parseIssueUrl("https://GitHub.com/Acme/Web/issues/12/")).toEqual({
      host: "github.com",
      repository: "acme/web",
      number: 12,
    });
  });
  it("rejects pull requests and other pages", () => {
    expect(parseIssueUrl("https://github.com/acme/web/pull/12")).toBeNull();
    expect(parseIssueUrl("https://github.com/acme/web/issues")).toBeNull();
    expect(parseIssueUrl("not a url")).toBeNull();
  });
});

describe("gitHubRepositoryOf", () => {
  it("names GitHub repositories only", () => {
    expect(gitHubRepositoryOf({ canonicalKey: "github.com/Acme/Web", provider: "github" })).toEqual(
      { host: "github.com", repository: "acme/web" },
    );
    expect(
      gitHubRepositoryOf({ canonicalKey: "gitlab.com/acme/web", provider: "gitlab" }),
    ).toBeNull();
    expect(gitHubRepositoryOf(null)).toBeNull();
  });
});

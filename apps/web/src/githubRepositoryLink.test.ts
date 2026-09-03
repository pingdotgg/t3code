import { describe, expect, it } from "vite-plus/test";

import {
  collectGitHubRepositoryLinkMatches,
  parseGitHubRepositoryLink,
} from "./githubRepositoryLink";

describe("parseGitHubRepositoryLink", () => {
  it("recognizes canonical repository URLs", () => {
    expect(parseGitHubRepositoryLink("https://github.com/pingdotgg/t3code/")).toEqual({
      href: "https://github.com/pingdotgg/t3code/",
      nameWithOwner: "pingdotgg/t3code",
    });
    expect(parseGitHubRepositoryLink("https://www.github.com/pingdotgg/t3code.git")).toEqual({
      href: "https://www.github.com/pingdotgg/t3code.git",
      nameWithOwner: "pingdotgg/t3code",
    });
  });

  it.each([
    "https://github.com/pingdotgg/t3code/issues/1",
    "https://example.com/pingdotgg/t3code",
    "https://github.com/pingdotgg/t3code with spaces",
  ])("rejects non-repository URLs: %s", (href) => {
    expect(parseGitHubRepositoryLink(href)).toBeNull();
  });
});

describe("collectGitHubRepositoryLinkMatches", () => {
  it("collects complete repository links and excludes sentence punctuation", () => {
    const text = "Review https://github.com/pingdotgg/t3code?tab=readme, then continue.";

    expect(collectGitHubRepositoryLinkMatches(text)).toEqual([
      {
        href: "https://github.com/pingdotgg/t3code?tab=readme",
        nameWithOwner: "pingdotgg/t3code",
        source: "https://github.com/pingdotgg/t3code?tab=readme",
        start: 7,
        end: 53,
      },
    ]);
  });

  it("requires whitespace after a link before making it a composer token", () => {
    expect(collectGitHubRepositoryLinkMatches("https://github.com/pingdotgg/t3code")).toEqual([]);
  });
});

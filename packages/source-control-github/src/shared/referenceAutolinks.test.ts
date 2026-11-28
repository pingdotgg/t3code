import { describe, expect, it } from "vite-plus/test";

import { gitHubReferenceAutolinks } from "./referenceAutolinks.ts";

const repositoryUrl = "https://github.com/team/repo";
const linked = (text: string) =>
  gitHubReferenceAutolinks(text, repositoryUrl).map(({ label, url, kind }) => [label, url, kind]);

describe("gitHubReferenceAutolinks", () => {
  it("links references, cross-repository references, commits and mentions", () => {
    expect(
      linked(
        "Closes #123, fixes other/project#9; other#4 @julius @team/mobile abc1234 other/project@abcdef1",
      ),
    ).toEqual([
      ["#123", "https://github.com/team/repo/issues/123", "reference"],
      ["other/project#9", "https://github.com/other/project/issues/9", "reference"],
      ["other#4", "https://github.com/other/repo/issues/4", "reference"],
      ["@julius", "https://github.com/julius", "mention"],
      ["@team/mobile", "https://github.com/orgs/team/teams/mobile", "mention"],
      ["abc1234", "https://github.com/team/repo/commit/abc1234", "commit"],
      ["other/project@abcdef1", "https://github.com/other/project/commit/abcdef1", "commit"],
    ]);
  });

  it("shows a full SHA by its first seven characters", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(linked(`Reverts ${sha}.`)).toEqual([
      ["0123456", `https://github.com/team/repo/commit/${sha}`, "commit"],
    ]);
  });

  it("links case-insensitive GH- issue references against the repository", () => {
    expect(linked("GH-26")).toEqual([
      ["GH-26", "https://github.com/team/repo/issues/26", "reference"],
    ]);
    expect(linked("Fixes gh-27, Gh-18, (GH-32), GH-017 and GH-26-foo.")).toEqual([
      ["gh-27", "https://github.com/team/repo/issues/27", "reference"],
      ["Gh-18", "https://github.com/team/repo/issues/18", "reference"],
      ["GH-32", "https://github.com/team/repo/issues/32", "reference"],
      ["GH-017", "https://github.com/team/repo/issues/17", "reference"],
      ["GH-26", "https://github.com/team/repo/issues/26", "reference"],
    ]);
    expect(linked("GH-26#12 GH-26@abcdef1")).toEqual([
      ["GH-26#12", "https://github.com/GH-26/repo/issues/12", "reference"],
      ["GH-26@abcdef1", "https://github.com/GH-26/repo/commit/abcdef1", "commit"],
    ]);
  });

  it("leaves URLs, escapes, emails, words and plain numbers alone", () => {
    expect(
      linked(
        "https://example.com/#123 https://example.com/GH-26 user@example.com \\#123 \\GH-26 1234567 issue#x a#1b xGH-31 foo-GH-31 GH-0 GH-00 GH-26x GH-26_ owner/repoGH-26",
      ),
    ).toEqual([]);
  });

  it("scans long runs of periods, dashes and leading zeros in linear time", () => {
    expect(linked(`${".".repeat(50_000)} ${".-".repeat(25_000)} #1`)).toEqual([
      ["#1", "https://github.com/team/repo/issues/1", "reference"],
    ]);
    expect(linked(`GH-${"0".repeat(50_000)} GH-1`)).toEqual([
      ["GH-1", "https://github.com/team/repo/issues/1", "reference"],
    ]);
  });

  it("links references that follow punctuation", () => {
    expect(linked("(#5), owner.name/repo-x#3")).toEqual([
      ["#5", "https://github.com/team/repo/issues/5", "reference"],
      ["owner.name/repo-x#3", "https://github.com/owner.name/repo-x/issues/3", "reference"],
    ]);
  });

  it("links against the repository's own host", () => {
    expect(
      gitHubReferenceAutolinks("See #5 and GH-6", "https://ghe.example.com/acme/web").map(
        ({ url }) => url,
      ),
    ).toEqual([
      "https://ghe.example.com/acme/web/issues/5",
      "https://ghe.example.com/acme/web/issues/6",
    ]);
  });
});

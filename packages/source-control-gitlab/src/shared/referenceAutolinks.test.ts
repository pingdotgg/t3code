import { describe, expect, it } from "vite-plus/test";

import { gitLabReferenceAutolinks } from "./referenceAutolinks.ts";

const repositoryUrl = "https://gitlab.com/team/apps/web";
const linked = (text: string) =>
  gitLabReferenceAutolinks(text, repositoryUrl).map(({ label, url, kind }) => [label, url, kind]);

describe("gitLabReferenceAutolinks", () => {
  it("links issues, merge requests, cross-project references, commits and mentions", () => {
    expect(
      linked(
        "Closes #123 and !45, see api!9, other/group/lib#2; @julius.dev @team/mobile abc1234 api@abcdef1 GL-7 [issue:8] [issue:api/9] [issue:other/lib/3]",
      ),
    ).toEqual([
      ["#123", "https://gitlab.com/team/apps/web/-/issues/123", "reference"],
      ["!45", "https://gitlab.com/team/apps/web/-/merge_requests/45", "reference"],
      ["api!9", "https://gitlab.com/team/apps/api/-/merge_requests/9", "reference"],
      ["other/group/lib#2", "https://gitlab.com/other/group/lib/-/issues/2", "reference"],
      ["@julius.dev", "https://gitlab.com/julius.dev", "mention"],
      ["@team/mobile", "https://gitlab.com/team/mobile", "mention"],
      ["abc1234", "https://gitlab.com/team/apps/web/-/commit/abc1234", "commit"],
      ["api@abcdef1", "https://gitlab.com/team/apps/api/-/commit/abcdef1", "commit"],
      ["GL-7", "https://gitlab.com/team/apps/web/-/issues/7", "reference"],
      ["[issue:8]", "https://gitlab.com/team/apps/web/-/issues/8", "reference"],
      ["[issue:api/9]", "https://gitlab.com/team/apps/api/-/issues/9", "reference"],
      ["[issue:other/lib/3]", "https://gitlab.com/other/lib/-/issues/3", "reference"],
    ]);
  });

  it("shows a full SHA by its first seven characters", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(linked(`Reverts ${sha}.`)).toEqual([
      ["0123456", `https://gitlab.com/team/apps/web/-/commit/${sha}`, "commit"],
    ]);
  });

  it("leaves URLs, escapes, emails, words, plain numbers and @all alone", () => {
    expect(
      linked(
        "https://gitlab.com/a/b/-/issues/1#note_2 user@example.com \\!12 1234567 issue#x a!1b @all gl-4 XGL-5",
      ),
    ).toEqual([]);
  });

  it("scans long runs of periods, dashes and slashes in linear time", () => {
    expect(linked(`${".".repeat(50_000)} ${".-/".repeat(25_000)} !1`)).toEqual([
      ["!1", "https://gitlab.com/team/apps/web/-/merge_requests/1", "reference"],
    ]);
  });

  it("links references that follow punctuation and a mention's trailing period", () => {
    expect(linked("(!5), thanks @julius.")).toEqual([
      ["!5", "https://gitlab.com/team/apps/web/-/merge_requests/5", "reference"],
      ["@julius", "https://gitlab.com/julius", "mention"],
    ]);
  });

  it("links against the repository's own host", () => {
    expect(
      gitLabReferenceAutolinks("See !5", "https://git.example.com/acme/web").map(({ url }) => url),
    ).toEqual(["https://git.example.com/acme/web/-/merge_requests/5"]);
  });
});

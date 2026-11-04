import { describe, expect, it } from "vite-plus/test";

import { containsChangeRequestUrl, isSshRemoteUrl } from "./sourceControl.ts";

describe("containsChangeRequestUrl", () => {
  it.each([
    "Opened https://github.com/pingdotgg/t3code/pull/42",
    "Opened https://gitlab.example.com/group/project/-/merge_requests/42.",
    "Opened https://dev.azure.com/acme/project/_git/t3code/pullrequest/42",
    "Opened https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
  ])("accepts supported change request URLs in agent text", (text) => {
    expect(containsChangeRequestUrl(text)).toBe(true);
  });

  it.each([
    "I will open a pull request next.",
    "https://github.com/pingdotgg/t3code/issues/42",
    "https://example.com/pull/not-a-number",
  ])("rejects text without a supported change request URL", (text) => {
    expect(containsChangeRequestUrl(text)).toBe(false);
  });
});

describe("isSshRemoteUrl", () => {
  it.each([
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "github.com:owner/repo.git",
    "github-work:owner/repo.git",
  ])("reads %s as SSH", (remoteUrl) => {
    expect(isSshRemoteUrl(remoteUrl)).toBe(true);
  });

  it.each([
    "https://github.com/owner/repo.git",
    "C:/repos/repo",
    "/srv/git/repo.git",
    "./team:group/repo",
    "file:///srv/git/repo.git",
    "hg::owner/repo",
  ])("does not read %s as SSH", (remoteUrl) => {
    expect(isSshRemoteUrl(remoteUrl)).toBe(false);
  });
});

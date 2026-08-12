import { describe, expect, it } from "vite-plus/test";

import { parseChangeRequestUrl, repositoryFromIdentity } from "./pullRequestLinks";

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request", () => {
    expect(parseChangeRequestUrl("https://github.com/T3Tools/T3Code/pull/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads a pull request on a GitHub Enterprise host", () => {
    expect(parseChangeRequestUrl("https://github.acme.test/platform/api/pull/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads a GitLab merge request, nested groups and all", () => {
    expect(
      parseChangeRequestUrl("https://gitlab.com/t3tools/platform/t3code/-/merge_requests/42"),
    ).toEqual({
      host: "gitlab.com",
      repository: "t3tools/platform/t3code",
      number: 42,
    });
  });

  it("reads a Bitbucket pull request", () => {
    expect(parseChangeRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/5")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
  });

  it("claims nothing it cannot be sure of", () => {
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/issues/123")).toBeNull();
    expect(parseChangeRequestUrl("https://example.com/pull/1")).toBeNull();
  });
});

describe("repositoryFromIdentity", () => {
  it("prefers displayName, then owner/name", () => {
    expect(repositoryFromIdentity({ displayName: "acme/app", owner: "x", name: "y" })).toBe(
      "acme/app",
    );
    expect(repositoryFromIdentity({ displayName: null, owner: "acme", name: "app" })).toBe(
      "acme/app",
    );
    expect(repositoryFromIdentity(null)).toBeNull();
  });
});

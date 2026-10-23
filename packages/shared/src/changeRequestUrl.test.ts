import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestUrlFor,
  matchesLinkedPullRequestUrl,
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  siblingPullRequestUrl,
} from "./changeRequestUrl.ts";
import { normalizeThreadPullRequestKey } from "./threadPullRequests.ts";

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request, lower-casing the repository", () => {
    expect(parseChangeRequestUrl("https://github.com/T3Tools/T3Code/pull/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads a GitCafe pull request at its canonical /pull/ path and the older /pulls/ path", () => {
    for (const path of ["pull", "pulls"]) {
      expect(
        parseChangeRequestUrl(`https://git.cafe/PingDotGG/T3Code/${path}/23897`),
        path,
      ).toEqual({ host: "git.cafe", repository: "pingdotgg/t3code", number: 23897 });
    }
    expect(parseChangeRequestUrl("https://staging.git.cafe/team/repo/pull/7/files")).toEqual({
      host: "staging.git.cafe",
      repository: "team/repo",
      number: 7,
    });
  });

  it("reads Forgejo URLs even when the hostname contains github", () => {
    expect(parseChangeRequestUrl("https://github.internal/team/repo/pulls/7")).toEqual({
      host: "github.internal",
      authority: "github.internal",
      repository: "team/repo",
      number: 7,
    });
  });

  it("reads a supported GitHub host with a middle DNS label", () => {
    expect(parseChangeRequestUrl("https://code.github.example.com/acme/web/pull/42")).toEqual({
      host: "code.github.example.com",
      repository: "acme/web",
      number: 42,
    });
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://code.github.example.com/acme/web/issues/42",
      ),
    ).toBe("https://code.github.example.com/acme/web/pull/42");
  });

  it("reads a GitLab merge request on any host, nested groups and all", () => {
    expect(
      parseChangeRequestUrl("https://gitlab.com/t3tools/platform/t3code/-/merge_requests/42"),
    ).toEqual({ host: "gitlab.com", repository: "t3tools/platform/t3code", number: 42 });
    expect(parseChangeRequestUrl("https://code.acme.test/team/project/-/merge_requests/9")).toEqual(
      { host: "code.acme.test", repository: "team/project", number: 9 },
    );
  });

  it("reads Bitbucket and both Azure DevOps URL forms", () => {
    expect(parseChangeRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/5")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
    expect(
      parseChangeRequestUrl("https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17"),
    ).toEqual({ host: "dev.azure.com", repository: "acme/platform/_git/t3code", number: 17 });
    expect(
      parseChangeRequestUrl("https://acme.visualstudio.com/platform/_git/t3code/pullrequest/17"),
    ).toEqual({ host: "acme.visualstudio.com", repository: "platform/_git/t3code", number: 17 });
  });

  it("reads Azure DevOps Server links and keeps servers on different ports distinct", () => {
    for (const host of ["scm.example.test", "git.cafe", "code.bitbucket.example.test"]) {
      const repository = "tfs/collection/project/_git/repo";
      const linked = {
        projectId: ProjectId.make("project-1"),
        host,
        repository,
        number: 123,
        url: `https://${host.toUpperCase()}:8443/tfs/Collection/Project/_git/Repo/pullrequest/123`,
      };
      const other = { ...linked, url: linked.url.replace(":8443/", ":9443/") };
      expect.soft(parseChangeRequestUrl(linked.url), host).toEqual({
        host,
        authority: `${host}:8443`,
        repository,
        number: 123,
      });
      expect.soft(matchesLinkedPullRequestUrl(linked, `${linked.url}?view=files`), host).toBe(true);
      expect.soft(matchesLinkedPullRequestUrl(linked, other.url), host).toBe(false);
      expect.soft([linked, other].map(normalizeThreadPullRequestKey), host).toEqual([
        { host: `${host}:8443`, repository, number: 123 },
        { host: `${host}:9443`, repository, number: 123 },
      ]);
    }
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/files?w=1")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of", () => {
    for (const link of [
      "https://github.com/t3tools/t3code/issues/123",
      "https://git.cafe/pingdotgg/t3code/issues/23897",
      "https://git.cafe/pingdotgg/t3code/pull/abc",
      "https://git.cafe/pingdotgg/t3code",
      "https://github.com/t3tools/t3code/commit/0a1b2c3",
      "https://github.com/t3tools/t3code",
      "https://github.com/t3tools/t3code/pull/abc",
      "https://gitlab.com/t3tools/t3code/-/issues/12",
      "https://blog.example.test/2026/updates/pull/3",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo",
      "https://scm.example.test/tfs/Collection/Project/pullrequest/123",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/abc",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/0",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/9007199254740992",
      "ftp://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123",
      "javascript:alert(1)//github.com/t3tools/t3code/pull/1",
      "not a url",
    ]) {
      expect(parseChangeRequestUrl(link), link).toBeNull();
    }
  });
});

describe("siblingPullRequestUrl", () => {
  it.each([
    [
      "http://git.example.test:3000/team/repo/pulls/42/files",
      "http://git.example.test:3000/team/repo/pulls/43",
    ],
    ["https://github.com/pull/1/pull/42/files", "https://github.com/pull/1/pull/43"],
    [
      "https://dev.azure.com/acme/project/_git/web/pullrequest/42?view=files",
      "https://dev.azure.com/acme/project/_git/web/pullrequest/43",
    ],
  ])("builds a canonical sibling of %s", (url, expected) => {
    expect(siblingPullRequestUrl(url, 43)).toBe(expected);
  });
});

describe("changeRequestUrlFor", () => {
  it("preserves the origin when the Forgejo host already contains its port", () => {
    expect(
      changeRequestUrlFor(
        "forgejo",
        "forge.example:3000",
        "team/repo",
        42,
        "http://forge.example:3000/team/repo.git",
      ),
    ).toBe("http://forge.example:3000/team/repo/pulls/42");
  });

  it.each([
    ["http://forge.example:3000/git/owner/repo.git", "http://forge.example:3000"],
    ["git@forge.example:git/owner/repo.git", "https://forge.example"],
    ["http://other.example:3000/git/owner/repo.git", "https://forge.example"],
  ])("preserves the matching Forgejo web origin from %s", (remoteUrl, origin) => {
    expect(changeRequestUrlFor("forgejo", "forge.example", "git/owner/repo", 42, remoteUrl)).toBe(
      `${origin}/git/owner/repo/pulls/42`,
    );
  });

  it.each([
    ["ssh.dev.azure.com", "v3/org/project/web"],
    ["org.visualstudio.com", "defaultcollection/project/_git/web"],
    ["dev.azure.com", "org/project/_git/web"],
  ])("builds a browser URL from the Azure remote %s/%s", (host, repository) => {
    const url = changeRequestUrlFor("azure-devops", host, repository, 42);
    expect(url).toBe("https://dev.azure.com/org/project/_git/web/pullrequest/42");
    expect(parseChangeRequestUrl(url!)).toEqual({
      host: "dev.azure.com",
      repository: "org/project/_git/web",
      number: 42,
    });
  });
});

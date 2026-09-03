import { describe, expect, it, vi } from "vite-plus/test";

import {
  changeRequestRepositoryUrl,
  findProjectForChangeRequest,
  gitHubPullRequestBrowserUrl,
  matchesLinkedPullRequestUrl,
  openPullRequestLink,
  parseChangeRequestUrl,
  PullRequestLinkOpenError,
  shouldOpenPullRequestExternally,
} from "./openPullRequestLink";
import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";

function repositoryIdentity(
  provider: string,
  canonicalKey: string,
  remoteUrl: string,
): RepositoryIdentity {
  return {
    canonicalKey,
    provider,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  };
}

describe("gitHubPullRequestBrowserUrl", () => {
  it("uses the requested GitHub repository instead of the project's default repository", () => {
    const identity = repositoryIdentity(
      "github",
      "github.com/acme/default",
      "https://github.com/acme/default.git",
    );

    expect(gitHubPullRequestBrowserUrl(identity, "acme/other", 42)).toBe(
      "https://github.com/acme/other/pull/42",
    );
  });

  it("preserves a custom GitHub HTTP origin without its credentials", () => {
    const identity = repositoryIdentity(
      "github",
      "github.acme.test/team/default",
      "http://token@github.acme.test:8443/team/default.git",
    );

    expect(gitHubPullRequestBrowserUrl(identity, "platform/api", 7)).toBe(
      "http://github.acme.test:8443/platform/api/pull/7",
    );
  });

  it.each([
    {
      name: "SSH",
      remoteUrl: "git@github.acme.test:team/default.git",
    },
    {
      name: "git protocol",
      remoteUrl: "git://github.acme.test/team/default.git",
    },
  ])("uses the normalized host for a $name remote", ({ remoteUrl }) => {
    const identity = repositoryIdentity("github", "github.acme.test/team/default", remoteUrl);

    expect(gitHubPullRequestBrowserUrl(identity, "platform/api", 9)).toBe(
      "https://github.acme.test/platform/api/pull/9",
    );
  });

  it("returns null for missing or invalid GitHub data", () => {
    expect(gitHubPullRequestBrowserUrl(null, "acme/repository", 1)).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "acme",
        1,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "../repository",
        1,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "acme/repository",
        0,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "bad host/acme/repository", "not a remote"),
        "acme/repository",
        1,
      ),
    ).toBeNull();
  });

  it.each(["gitlab", "bitbucket", "azure-devops", "unknown"])(
    "does not build a fallback for %s",
    (provider) => {
      expect(
        gitHubPullRequestBrowserUrl(
          repositoryIdentity(provider, "github.com/acme/repository", "https://github.com/a/b"),
          "acme/repository",
          1,
        ),
      ).toBeNull();
    },
  );
});

describe("changeRequestRepositoryUrl", () => {
  it("preserves repository path casing", () => {
    expect(
      changeRequestRepositoryUrl(
        "https://gitlab.example.test/Team/Platform/Repo/-/merge_requests/42/diffs#note_1",
      ),
    ).toBe("https://gitlab.example.test/Team/Platform/Repo");
  });

  it("keeps pull-like segments inside nested GitLab repository paths", () => {
    expect(
      changeRequestRepositoryUrl(
        "https://gitlab.example.test/group/pull/123/repo/-/merge_requests/42",
      ),
    ).toBe("https://gitlab.example.test/group/pull/123/repo");
  });
});

describe("matchesLinkedPullRequestUrl", () => {
  const linkedPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };

  it("matches the same pull request without looking up its project", () => {
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.com/PingDotGG/T3Code/pull/42/files",
      ),
    ).toBe(true);
  });

  it("rejects a different pull request or host", () => {
    expect(
      matchesLinkedPullRequestUrl(linkedPullRequest, "https://github.com/pingdotgg/t3code/pull/43"),
    ).toBe(false);
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.example.com/pingdotgg/t3code/pull/42",
      ),
    ).toBe(false);
  });
});

describe("openPullRequestLink", () => {
  it("opens the requested pull request URL", async () => {
    const openExternal = vi.fn(async () => undefined);
    const targetUrl = "https://github.com/pingdotgg/t3code/pull/123";

    await openPullRequestLink({ openExternal }, targetUrl);

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(targetUrl);
  });

  it("reports bridge failures with a safe target origin", async () => {
    const cause = new Error("desktop shell unavailable");
    const targetUrl = "https://github.com/pingdotgg/t3code/pull/123?token=secret";
    const openExternal = vi.fn(async () => Promise.reject(cause));

    const result = openPullRequestLink({ openExternal }, targetUrl);

    await expect(result).rejects.toEqual(
      new PullRequestLinkOpenError({
        targetOrigin: "https://github.com",
        cause,
      }),
    );
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining("secret"));
  });
});

describe("shouldOpenPullRequestExternally", () => {
  it("uses the browser for command-click and control-click", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("keeps an unmodified click in the pull request view", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

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

  it("reads a merge request on a self-hosted GitLab named nothing like GitLab", () => {
    expect(parseChangeRequestUrl("https://code.acme.test/team/project/-/merge_requests/9")).toEqual(
      {
        host: "code.acme.test",
        repository: "team/project",
        number: 9,
      },
    );
  });

  it("reads a Bitbucket pull request", () => {
    expect(parseChangeRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/5")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
  });

  it("reads both Azure DevOps URL forms, keeping `_git` in the repository path", () => {
    expect(
      parseChangeRequestUrl("https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17"),
    ).toEqual({
      host: "dev.azure.com",
      repository: "acme/platform/_git/t3code",
      number: 17,
    });
    expect(
      parseChangeRequestUrl("https://acme.visualstudio.com/platform/_git/t3code/pullrequest/17"),
    ).toEqual({
      host: "acme.visualstudio.com",
      repository: "platform/_git/t3code",
      number: 17,
    });
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/files?w=1")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(
      parseChangeRequestUrl("https://gitlab.com/team/project/-/merge_requests/42/diffs#note_1"),
    ).toEqual({ host: "gitlab.com", repository: "team/project", number: 42 });
    expect(
      parseChangeRequestUrl("https://bitbucket.org/team/repo/pull-requests/5/commits"),
    ).toEqual({ host: "bitbucket.org", repository: "team/repo", number: 5 });
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of, so the link goes to the browser", () => {
    for (const link of [
      "https://github.com/t3tools/t3code/issues/123",
      "https://github.com/t3tools/t3code/commit/0a1b2c3",
      "https://github.com/t3tools/t3code",
      "https://github.com/t3tools/t3code/pull/abc",
      "https://gitlab.com/t3tools/t3code/-/snippets/12",
      "https://gitlab.com/t3tools/t3code/-/issues/12",
      // A path shape that means nothing off its own host.
      "https://blog.example.test/2026/updates/pull/3",
      // A lookalike is deliberately not fought here: `github.com.evil.test` reads as a GitHub
      // Enterprise install and there is no way to tell it from one. It is `findProjectForChange
      // Request` that refuses it, because no project in the workspace is checked out from it.
      "javascript:alert(1)//github.com/t3tools/t3code/pull/1",
      "not a url",
    ]) {
      expect(parseChangeRequestUrl(link), link).toBeNull();
    }
  });
});

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    // The server identifies a repository by `displayName`, which keeps every group segment; the
    // two-segment owner/name form would look for `t3tools/t3code` and find nothing.
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: "gitlab",
        displayName: "t3tools/platform/t3code",
        owner: "t3tools",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "gitlab.com",
        repository: "t3tools/platform/t3code",
        number: 42,
      }),
    ).toBe(projects[0]);
  });

  it("keeps two hosts apart, so an Enterprise link does not open the public one", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.acme.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.com-evil.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });
});

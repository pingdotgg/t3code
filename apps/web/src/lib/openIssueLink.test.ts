import { describe, expect, it, vi } from "vite-plus/test";

import {
  findProjectForIssue,
  IssueLinkOpenError,
  openIssueLink,
  parseIssueUrl,
  repositoryForProjectLink,
} from "./openIssueLink";

describe("openIssueLink", () => {
  it("opens the requested issue URL", async () => {
    const openExternal = vi.fn(async () => undefined);
    const targetUrl = "https://github.com/pingdotgg/t3code/issues/123";

    await openIssueLink({ openExternal }, targetUrl);

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(targetUrl);
  });

  it("reports bridge failures with a safe target origin", async () => {
    const cause = new Error("desktop shell unavailable");
    const targetUrl = "https://github.com/pingdotgg/t3code/issues/123?token=secret";
    const openExternal = vi.fn(async () => Promise.reject(cause));

    const result = openIssueLink({ openExternal }, targetUrl);

    await expect(result).rejects.toEqual(
      new IssueLinkOpenError({
        targetOrigin: "https://github.com",
        cause,
      }),
    );
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining("secret"));
  });
});

describe("parseIssueUrl", () => {
  it("reads a GitHub issue", () => {
    expect(parseIssueUrl("https://github.com/T3Tools/T3Code/issues/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads an issue on a GitHub Enterprise host", () => {
    expect(parseIssueUrl("https://github.acme.test/platform/api/issues/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads a GitLab issue, nested groups and all", () => {
    expect(parseIssueUrl("https://gitlab.com/t3tools/platform/t3code/-/issues/42")).toEqual({
      host: "gitlab.com",
      repository: "t3tools/platform/t3code",
      number: 42,
    });
  });

  it("reads an issue on a self-hosted GitLab named nothing like GitLab", () => {
    expect(parseIssueUrl("https://code.acme.test/team/project/-/issues/9")).toEqual({
      host: "code.acme.test",
      repository: "team/project",
      number: 9,
    });
  });

  it("reads a Bitbucket issue", () => {
    expect(parseIssueUrl("https://bitbucket.org/workspace/repo/issues/5")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
  });

  it("reads both Azure DevOps work item URL forms, organisation and project only", () => {
    expect(parseIssueUrl("https://dev.azure.com/acme/platform/_workitems/edit/17")).toEqual({
      host: "dev.azure.com",
      repository: "acme/platform",
      number: 17,
    });
    expect(parseIssueUrl("https://acme.visualstudio.com/platform/_workitems/edit/17")).toEqual({
      host: "acme.visualstudio.com",
      repository: "platform",
      number: 17,
    });
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parseIssueUrl("https://github.com/t3tools/t3code/issues/123/comments?w=1")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(parseIssueUrl("https://gitlab.com/team/project/-/issues/42#note_1")).toEqual({
      host: "gitlab.com",
      repository: "team/project",
      number: 42,
    });
    expect(parseIssueUrl("https://bitbucket.org/team/repo/issues/5/comments")).toEqual({
      host: "bitbucket.org",
      repository: "team/repo",
      number: 5,
    });
    expect(parseIssueUrl("https://github.com/t3tools/t3code/issues/123/")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of, so the link goes to the browser", () => {
    for (const link of [
      // A pull request, not an issue: the same repository, the wrong path.
      "https://github.com/t3tools/t3code/pull/123",
      "https://github.com/t3tools/t3code/commit/0a1b2c3",
      "https://github.com/t3tools/t3code",
      "https://github.com/t3tools/t3code/issues/abc",
      "https://gitlab.com/t3tools/t3code/-/merge_requests/12",
      "https://gitlab.com/t3tools/t3code/-/snippets/12",
      // A path shape that means nothing off its own host.
      "https://blog.example.test/2026/updates/issues/3",
      // Bitbucket's own path shape, but not on a host that could plausibly be it.
      "https://code.acme.test/team/project/issues/9",
      // A lookalike is deliberately not fought here: `github.com.evil.test` reads as a GitHub
      // Enterprise install and there is no way to tell it from one. It is `findProjectForIssue`
      // that refuses it, because no project in the workspace is checked out from it.
      "javascript:alert(1)//github.com/t3tools/t3code/issues/1",
      "not a url",
    ]) {
      expect(parseIssueUrl(link), link).toBeNull();
    }
  });
});

describe("findProjectForIssue", () => {
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
      findProjectForIssue(projects, {
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
      findProjectForIssue(projects, {
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
      findProjectForIssue(projects, {
        host: "github.com-evil.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });

  it("matches an Azure DevOps work item to any repository under its team project", () => {
    // A work item names only `{organisation}/{project}`; the project's identity carries the git
    // repository below it, so the match is a prefix rather than the exact path the other hosts use.
    const projects = [
      project({
        canonicalKey: "dev.azure.com/acme/platform/_git/t3code",
        provider: "azure-devops",
        displayName: "acme/platform/_git/t3code",
        owner: "acme/platform",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForIssue(projects, {
        host: "dev.azure.com",
        repository: "acme/platform",
        number: 17,
      }),
    ).toBe(projects[0]);
  });

  it("does not let a nested GitLab project claim an issue filed on the group above it", () => {
    // Only an Azure DevOps work item names a path above the repository. A GitLab link names the
    // whole project path, so `group/repo` is a different repository from `group/repo/subrepo`.
    const projects = [
      project({
        canonicalKey: "gitlab.com/group/repo/subrepo",
        provider: "gitlab",
        displayName: "group/repo/subrepo",
        owner: "group/repo",
        name: "subrepo",
      }),
    ];
    expect(
      findProjectForIssue(projects, {
        host: "gitlab.com",
        repository: "group/repo",
        number: 7,
      }),
    ).toBeUndefined();
  });

  it("does not let one team project's prefix match another with a similar name", () => {
    const projects = [
      project({
        canonicalKey: "dev.azure.com/acme/platformx/_git/t3code",
        provider: "azure-devops",
        displayName: "acme/platformx/_git/t3code",
        owner: "acme/platformx",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForIssue(projects, {
        host: "dev.azure.com",
        repository: "acme/platform",
        number: 17,
      }),
    ).toBeUndefined();
  });
});

describe("repositoryForProjectLink", () => {
  it("keeps the repository identity casing used by the provider", () => {
    const project = {
      repositoryIdentity: { displayName: "Acme/Web" },
    } as never;

    expect(repositoryForProjectLink(project, "acme/web")).toBe("Acme/Web");
  });
});

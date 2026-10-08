import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestWebUrl,
  linkIssuePreviewMatchesReference,
  linkPullRequestPreviewTarget,
  linkReferenceKind,
  resolveLinkIssueInput,
  resolveLinkPullRequestInput,
} from "./LinkPullRequestDialog";

const project = {
  host: "github.com",
  repository: "acme/web",
  webUrl: (number: number) => changeRequestWebUrl("github", "github.com", "acme/web", number),
};

describe("linkIssuePreviewMatchesReference", () => {
  it.each([
    ["https://linear.app/workspace-b/issue/ENG-42/old-title", true],
    ["https://linear.app/workspace-a/issue/ENG-42", false],
    ["https://linear.app/workspace-b/issue/ENG-43", false],
    ["https://linear.app/workspace-b/issue/OPS-42", false],
    ["#42", true],
  ])("checks the Linear workspace and identifier for %s", (reference, matches) => {
    expect(
      linkIssuePreviewMatchesReference(reference, {
        provider: "linear",
        url: "https://linear.app/workspace-b/issue/ENG-42/new-title",
      }),
    ).toBe(matches);
  });

  it("refuses an issue read that answered with a pull request", () => {
    expect(
      linkIssuePreviewMatchesReference("#42", {
        provider: "github",
        url: "https://github.com/acme/web/pull/42",
      }),
    ).toBe(false);
    expect(
      linkIssuePreviewMatchesReference("#42", {
        provider: "github",
        url: "https://github.com/acme/web/issues/42",
      }),
    ).toBe(true);
  });
});

describe("resolveLinkPullRequestInput", () => {
  it.each([
    ["https://bitbucket.org/acme/web/pull-requests/42", "bitbucket.org"],
    ["https://github.acme.test/acme/web/pull/42", "github.acme.test"],
    ["https://git.acme.test/acme/web/-/merge_requests/42", "git.acme.test"],
  ])("links supported host URL %s without a thread project", (url, host) => {
    expect(
      resolveLinkPullRequestInput({
        reference: ` ${url} `,
        project: null,
        hasProject: (candidate) => candidate.host === host,
      }),
    ).toEqual({ link: { host, repository: "acme/web", number: 42, url } });
  });

  it("validates the full Azure repository when resolving a browser URL", () => {
    const hasProject = (reference: { host: string; repository: string }) =>
      reference.host === "dev.azure.com" && reference.repository === "org-a/project/_git/web";
    expect(
      resolveLinkPullRequestInput({
        reference: "https://dev.azure.com/org-a/project/_git/web/pullrequest/42",
        project: null,
        hasProject,
      }),
    ).toMatchObject({ link: { repository: "org-a/project/_git/web", number: 42 } });
    expect(
      resolveLinkPullRequestInput({
        reference: "https://dev.azure.com/org-b/project/_git/web/pullrequest/42",
        project: null,
        hasProject,
      }),
    ).toMatchObject({ error: expect.stringContaining("org-b/project/_git/web") });
  });

  it("resolves bare Azure numbers into canonical browser URLs", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "#42",
        project: {
          host: "ssh.dev.azure.com",
          repository: "v3/org/project/web",
          webUrl: (number) =>
            changeRequestWebUrl("azure-devops", "ssh.dev.azure.com", "v3/org/project/web", number),
        },
        hasProject: () => true,
      }),
    ).toMatchObject({
      link: {
        host: "dev.azure.com",
        repository: "org/project/_git/web",
        number: 42,
        url: "https://dev.azure.com/org/project/_git/web/pullrequest/42",
      },
    });
  });

  it.each(["hello", "#0", "https://github.com/acme/web/pull/0"])(
    "returns null for %s, which is not a reference",
    (reference) => {
      expect(
        resolveLinkPullRequestInput({ reference, project, hasProject: () => true }),
      ).toBeNull();
    },
  );

  it("resolves a bare number against the thread's own repository", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "#42", project, hasProject: () => true }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "acme/web",
        number: 42,
        url: "https://github.com/acme/web/pull/42",
      },
    });
  });

  it("links a URL from another repository on a host with a project", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "https://github.com/acme/api/pull/7",
        project,
        hasProject: (reference) => reference.host === "github.com",
      }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "acme/api",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
      },
    });
  });

  it("refuses a URL on a host nothing is checked out from", () => {
    const result = resolveLinkPullRequestInput({
      reference: "https://gitlab.com/acme/api/-/merge_requests/7",
      project,
      hasProject: () => false,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("gitlab.com") });
  });

  it("asks for a URL when a bare number has no project to resolve against", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "12", project: null, hasProject: () => true }),
    ).toMatchObject({ error: expect.stringContaining("full URL") });
  });

  it("accepts a checkout command as a reference", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "gh pr checkout https://github.com/acme/web/pull/3",
        project,
        hasProject: () => true,
      }),
    ).toMatchObject({ link: { number: 3, repository: "acme/web" } });
  });
});

describe("changeRequestWebUrl", () => {
  it("knows the four hosts and nothing else", () => {
    expect(changeRequestWebUrl("gitlab", "gitlab.com", "g/sub/repo", 5)).toBe(
      "https://gitlab.com/g/sub/repo/-/merge_requests/5",
    );
    expect(changeRequestWebUrl("unknown", "x", "a/b", 1)).toBeNull();
  });
});

describe("linkReferenceKind", () => {
  it.each([
    ["https://github.com/acme/web/issues/4", "issue"],
    ["https://github.com/groups/repo/issues/4", "issue"],
    ["https://dev.azure.com/groups/project/_workitems/edit/4", "issue"],
    ["https://bitbucket.org/acme/web/issues/4/fix-login", "issue"],
    ["https://gitlab.com/g/sub/repo/-/issues/4", "issue"],
    ["https://gitlab.com/g/sub/repo/-/work_items/4", "issue"],
    ["acme/api#4", "issue"],
    ["https://github.com/acme/web/issues/4/files", "pull-request"],
    ["https://gitlab.com/groups/g/-/work_items/4", "pull-request"],
    ["https://dev.azure.com/org/project/_workitems/edit/4", "issue"],
    ["https://github.com/acme/web/pull/4", "pull-request"],
    ["https://linear.app/acme/issue/ENG-4/fix-login", "issue"],
    ["gh pr checkout 4", "pull-request"],
  ] as const)("detects %s as %s whatever was chosen", (reference, kind) => {
    expect(linkReferenceKind(reference, "issue")).toBe(kind);
    expect(linkReferenceKind(reference, "pull-request")).toBe(kind);
  });

  it("lets the chosen kind decide a bare number", () => {
    expect(linkReferenceKind("#4", "issue")).toBe("issue");
    expect(linkReferenceKind("4", "pull-request")).toBe("pull-request");
  });
});

describe("resolveLinkIssueInput", () => {
  const own = { id: "p1" as never, host: "github.com", repository: "acme/web" };

  it("resolves a bare number against the thread's own repository", () => {
    expect(
      resolveLinkIssueInput({
        reference: "#9",
        project: own,
        findProject: () => undefined,
        linearProjectId: () => undefined,
      }),
    ).toEqual({ issue: { projectId: "p1", repository: "acme/web", number: 9 } });
  });

  it("asks for a URL when a bare number has no project", () => {
    expect(
      resolveLinkIssueInput({
        reference: "9",
        project: null,
        findProject: () => undefined,
        linearProjectId: () => undefined,
      }),
    ).toMatchObject({ error: expect.stringContaining("full URL") });
  });

  it("reads a URL with the project that owns its repository", () => {
    const findProject = (link: { host: string; repository: string }) =>
      link.host === "dev.azure.com" && link.repository === "org/project"
        ? { id: "p2" as never, repository: "org/project/web" }
        : undefined;
    expect(
      resolveLinkIssueInput({
        reference: "https://dev.azure.com/org/project/_workitems/edit/12",
        project: own,
        findProject,
        linearProjectId: () => undefined,
      }),
    ).toEqual({ issue: { projectId: "p2", repository: "org/project/web", number: 12 } });
    expect(
      resolveLinkIssueInput({
        reference: "https://github.com/other/repo/issues/12",
        project: own,
        findProject,
        linearProjectId: () => undefined,
      }),
    ).toMatchObject({ error: expect.stringContaining("github.com/other/repo") });
  });

  it.each([
    ["https://github.com/groups/repo/issues/7", "github.com", "groups/repo"],
    ["https://dev.azure.com/groups/project/_workitems/edit/7", "dev.azure.com", "groups/project"],
    ["https://bitbucket.org/acme/web/issues/7/fix-login", "bitbucket.org", "acme/web"],
  ])("preserves supported issue URL %s", (reference, host, repository) => {
    expect(
      resolveLinkIssueInput({
        reference,
        project: own,
        findProject: (link) =>
          link.host === host && link.repository === repository
            ? { id: "p2" as never, repository }
            : undefined,
        linearProjectId: () => undefined,
      }),
    ).toEqual({ issue: { projectId: "p2", repository, number: 7 } });
  });

  it("reads a GitLab work item through the project that owns its nested repository", () => {
    expect(
      resolveLinkIssueInput({
        reference: "https://gitlab.com/g/sub/repo/-/work_items/7?show=1#note_2",
        project: own,
        findProject: (link) =>
          link.host === "gitlab.com" && link.repository === "g/sub/repo"
            ? { id: "p2" as never, repository: "g/sub/repo" }
            : undefined,
        linearProjectId: () => undefined,
      }),
    ).toEqual({ issue: { projectId: "p2", repository: "g/sub/repo", number: 7 } });
  });

  it("reads owner/repo#N on the thread project's host", () => {
    const findProject = (link: { host: string; repository: string }) =>
      link.host === "github.com" && link.repository === "acme/api"
        ? { id: "p2" as never, repository: "acme/api" }
        : undefined;
    const resolve = (reference: string, project: typeof own | null = own) =>
      resolveLinkIssueInput({ reference, project, findProject, linearProjectId: () => undefined });
    expect(resolve("acme/api#5")).toEqual({
      issue: { projectId: "p2", repository: "acme/api", number: 5 },
    });
    expect(resolve("acme/other#5")).toMatchObject({
      error: expect.stringContaining("github.com/acme/other"),
    });
    expect(resolve("acme/api#5", null)).toMatchObject({
      error: expect.stringContaining("full URL"),
    });
    expect(resolve("acme/api5")).toBeNull();
  });

  it.each([
    "https://github.com/acme/web/issues/12/files",
    "https://github.com/acme/web/pull/12",
    "https://gitlab.com/groups/g/-/work_items/12",
    "ftp://github.com/acme/web/issues/12",
  ])("ignores %s, which names no repository issue", (reference) => {
    expect(
      resolveLinkIssueInput({
        reference,
        project: own,
        findProject: () => own,
        linearProjectId: () => undefined,
      }),
    ).toBeNull();
  });

  it("returns null for input that is not an issue reference", () => {
    expect(
      resolveLinkIssueInput({
        reference: "hello",
        project: own,
        findProject: () => own,
        linearProjectId: () => undefined,
      }),
    ).toBeNull();
  });

  it.each([
    "#0",
    "https://github.com/acme/web/issues/0",
    "https://dev.azure.com/org/project/_workitems/edit/0",
    "https://linear.app/acme/issue/ENG-0",
  ])("refuses number zero in %s", (reference) => {
    expect(
      resolveLinkIssueInput({
        reference,
        project: own,
        findProject: () => own,
        linearProjectId: () => own.id,
      }),
    ).toBeNull();
  });

  it("reads a Linear URL with the project bound to its team", () => {
    const linearProjectId = (team: string) => (team === "ENG" ? ("p3" as never) : undefined);
    expect(
      resolveLinkIssueInput({
        reference: "https://linear.app/acme/issue/ENG-12/fix-login",
        project: own,
        findProject: () => undefined,
        linearProjectId,
      }),
    ).toEqual({
      issue: {
        projectId: "p3",
        provider: "linear",
        host: "linear.app",
        repository: "ENG",
        number: 12,
      },
    });
    expect(
      resolveLinkIssueInput({
        reference: "https://linear.app/acme/issue/OPS-12",
        project: own,
        findProject: () => undefined,
        linearProjectId,
      }),
    ).toMatchObject({ error: expect.stringContaining("OPS") });
  });
});

describe("linkPullRequestPreviewTarget", () => {
  const backend = {
    id: "backend",
    environmentId: "env",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/backend",
      provider: "github",
      owner: "acme",
      name: "backend",
    },
  } as never;
  const target = (url: string, anyRepositoryOnHost: boolean) =>
    linkPullRequestPreviewTarget({
      environmentId: "env" as never,
      projects: [backend],
      pullRequestsEnabled: true,
      anyRepositoryOnHost,
      url,
    });

  it("reads another repository on the host through a project there, keeping its own repository", () => {
    expect(target("https://github.com/acme/frontend/pull/7", true)).toEqual({
      environmentId: "env",
      input: { projectId: "backend", host: "github.com", repository: "acme/frontend", number: 7 },
    });
  });

  it("leaves another repository unread where links are not host-wide", () => {
    expect(target("https://github.com/acme/frontend/pull/7", false)).toBeNull();
  });

  it("does not read a Azure repository nothing has checked out", () => {
    expect(target("https://dev.azure.com/org/project/_git/web/pullrequest/7", true)).toBeNull();
  });
});

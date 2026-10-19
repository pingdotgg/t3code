import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

import { parsePullRequestReference, resolveLinkPullRequestInput } from "./pullRequestLinkInput.ts";

const changeRequestWebUrl = (kind: string, host: string, repository: string, number: number) =>
  sourceControlClients.get(kind).changeRequestUrl({ host, repository, number });

const project = {
  host: "github.com",
  repository: "acme/web",
  webUrl: (number: number) => changeRequestWebUrl("github", "github.com", "acme/web", number),
};

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

  it("returns null for input that is not a reference", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "hello", project, hasProject: () => true }),
    ).toBeNull();
  });

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

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(parsePullRequestReference("https://github.com/pingdotgg/t3code/pull/42")).toBe(
      "https://github.com/pingdotgg/t3code/pull/42",
    );
  });

  it("accepts Azure DevOps pull request URLs", () => {
    expect(
      parsePullRequestReference("https://dev.azure.com/acme/project/_git/t3code/pullrequest/42"),
    ).toBe("https://dev.azure.com/acme/project/_git/t3code/pullrequest/42");
  });

  it("accepts GitLab merge request URLs", () => {
    expect(parsePullRequestReference("https://gitlab.com/group/project/-/merge_requests/42")).toBe(
      "https://gitlab.com/group/project/-/merge_requests/42",
    );
  });

  it("accepts legacy Azure DevOps pull request URLs", () => {
    expect(
      parsePullRequestReference("https://acme.visualstudio.com/project/_git/t3code/pullrequest/42"),
    ).toBe("https://acme.visualstudio.com/project/_git/t3code/pullrequest/42");
  });

  it("accepts raw numbers", () => {
    expect(parsePullRequestReference("42")).toBe("42");
  });

  it("accepts #number references", () => {
    expect(parsePullRequestReference("#42")).toBe("42");
  });

  it("accepts gh pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("gh pr checkout 42")).toBe("42");
  });

  it("accepts gh pr checkout commands with #number references", () => {
    expect(parsePullRequestReference("gh pr checkout #42")).toBe("42");
  });

  it("accepts gh pr checkout commands with GitHub pull request URLs", () => {
    expect(
      parsePullRequestReference("gh pr checkout https://github.com/pingdotgg/t3code/pull/42"),
    ).toBe("https://github.com/pingdotgg/t3code/pull/42");
  });

  it("accepts glab mr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("glab mr checkout 42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("az repos pr checkout --id 42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with equals-style ids", () => {
    expect(parsePullRequestReference("az repos pr checkout --id=42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with extra flags", () => {
    expect(parsePullRequestReference("az repos pr checkout --id 42 --remote-name origin")).toBe(
      "42",
    );
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });
});

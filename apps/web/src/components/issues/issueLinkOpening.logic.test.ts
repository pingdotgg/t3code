import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserMayBlockNewTab,
  issueLinkCandidate,
  openIssueOrPullRequestLink,
} from "./issueLinkOpening.logic";

const environmentId = EnvironmentId.make("env-1");

const project = (owner: string, name: string, host = "github.com") =>
  ({
    id: ProjectId.make(`${owner}-${name}`),
    environmentId,
    repositoryIdentity: {
      canonicalKey: `${host}/${owner}/${name}`,
      provider: "github",
      owner,
      name,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${host}/${owner}/${name}.git`,
      },
    },
  }) as unknown as EnvironmentProject;

const projects = [project("toolboxmd", "t3code")];

describe("issueLinkCandidate", () => {
  const capable = { environmentId, projects, pullRequests: true, threadPullRequests: true };

  it("reads a project's /issues/N as its pull request N", () => {
    expect(
      issueLinkCandidate({ ...capable, url: "https://github.com/toolboxmd/t3code/issues/40" }),
    ).toEqual({
      pullRequestUrl: "https://github.com/toolboxmd/t3code/pull/40",
      pullRequestTarget: {
        environmentId,
        input: {
          projectId: ProjectId.make("toolboxmd-t3code"),
          host: "github.com",
          repository: "toolboxmd/t3code",
          number: 40,
        },
      },
    });
  });

  it("reads another repository on the host through any project there", () => {
    const candidate = issueLinkCandidate({
      ...capable,
      url: "https://github.com/toolboxmd/agentsmd/issues/134",
    });
    expect(candidate?.pullRequestTarget?.input).toEqual({
      projectId: ProjectId.make("toolboxmd-t3code"),
      host: "github.com",
      repository: "toolboxmd/agentsmd",
      number: 134,
    });
  });

  it("has no pull request to read where the server reads none", () => {
    const url = "https://github.com/toolboxmd/agentsmd/issues/134";
    expect(
      issueLinkCandidate({ ...capable, url, threadPullRequests: false })?.pullRequestTarget,
    ).toBeNull();
    expect(
      issueLinkCandidate({ ...capable, url, pullRequests: false })?.pullRequestTarget,
    ).toBeNull();
    expect(
      issueLinkCandidate({ ...capable, url, environmentId: null })?.pullRequestTarget,
    ).toBeNull();
  });

  it("leaves every other link alone", () => {
    for (const url of [
      "https://github.com/toolboxmd/t3code/pull/40",
      "https://github.com/toolboxmd/t3code",
      "https://gitlab.com/acme/web/-/issues/3",
      "https://codeberg.org/acme/web/issues/3",
      "not a url",
    ]) {
      expect(issueLinkCandidate({ ...capable, url })).toBeNull();
    }
  });
});

describe("openIssueOrPullRequestLink", () => {
  const run = (overrides: Partial<Parameters<typeof openIssueOrPullRequestLink>[0]>) => {
    const opened: string[] = [];
    const result = openIssueOrPullRequestLink({
      readPullRequest: async () => null,
      openPullRequest: (url) => {
        opened.push(`pull-request ${url}`);
        return true;
      },
      readIssue: async () => false,
      openIssue: () => opened.push("issue"),
      openExternal: async () => void opened.push("external"),
      ...overrides,
    });
    return result.then((kind) => ({ kind, opened }));
  };

  it("opens a pull request in the app", async () => {
    const readIssue = async () => {
      throw new Error("not asked");
    };
    expect(await run({ readPullRequest: async () => "https://x/pull/1", readIssue })).toEqual({
      kind: "pull-request",
      opened: ["pull-request https://x/pull/1"],
    });
  });

  it("opens an Issue in the Issues panel when N is no pull request", async () => {
    expect(await run({ readIssue: async () => true })).toEqual({
      kind: "issue",
      opened: ["issue"],
    });
  });

  it("falls back to the browser when neither read succeeds or can run", async () => {
    const failing = async (): Promise<never> => {
      throw new Error("offline");
    };
    expect(await run({ readPullRequest: failing, readIssue: failing })).toEqual({
      kind: "external",
      opened: ["external"],
    });
    expect(await run({ readPullRequest: null, readIssue: null })).toEqual({
      kind: "external",
      opened: ["external"],
    });
  });

  it("moves on when the pull request panel cannot show it", async () => {
    expect(
      await run({
        readPullRequest: async () => "https://x/pull/1",
        openPullRequest: () => false,
      }),
    ).toEqual({ kind: "external", opened: ["external"] });
  });
});

describe("browserMayBlockNewTab", () => {
  const web = { desktop: false, linkTarget: "system" as const };

  it("asks for a fresh click only for a new web tab once the click's activation lapsed", () => {
    expect(browserMayBlockNewTab({ ...web, userActivationActive: false })).toBe(true);
    expect(browserMayBlockNewTab({ ...web, userActivationActive: true })).toBe(false);
  });

  it("opens directly on desktop and in the in-app browser", () => {
    expect(browserMayBlockNewTab({ ...web, desktop: true, userActivationActive: false })).toBe(
      false,
    );
    expect(browserMayBlockNewTab({ ...web, linkTarget: "app", userActivationActive: false })).toBe(
      false,
    );
  });

  it("opens directly where the browser does not report activation", () => {
    expect(browserMayBlockNewTab({ ...web, userActivationActive: undefined })).toBe(false);
  });
});

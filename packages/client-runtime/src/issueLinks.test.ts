import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isLinearIssueLink,
  linksAnotherLinearWorkspace,
  resolveIssueLinkTarget,
} from "./issueLinks.ts";

const project = (id: string, repository: string) =>
  ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("env"),
    repositoryIdentity: {
      canonicalKey: `github.com/${repository}`,
      provider: SourceControlProviderKind.make("github"),
      displayName: repository,
      owner: repository.split("/")[0],
      name: repository.split("/")[1],
    },
  }) as never;

describe("resolveIssueLinkTarget", () => {
  const projects = [project("p1", "acme/api"), project("p2", "acme/web")];

  it.each([
    {
      name: "reads an issue through the project bound to its repository",
      url: "https://github.com/acme/web/issues/7",
      expected: { projectId: "p2", scope: "acme/web", key: "7" },
    },
    {
      name: "lends a project on the same host to a repository no project is bound to",
      url: "https://github.com/other/repo/issues/9",
      expected: { projectId: "p1", scope: "other/repo", key: "9" },
    },
  ])("$name", ({ url, expected }) => {
    const target = resolveIssueLinkTarget({ url, projects });
    expect(target?.ref).toMatchObject({ tracker: "github", host: "github.com", ...expected });
  });

  it("prefers the project bound to the link's own port over one on the bare hostname", () => {
    const enterprise = (id: string, host: string) =>
      ({
        id: ProjectId.make(id),
        environmentId: EnvironmentId.make("env"),
        repositoryIdentity: {
          canonicalKey: `${host}/acme/web`,
          provider: SourceControlProviderKind.make("github"),
          displayName: "acme/web",
          owner: "acme",
          name: "web",
        },
      }) as never;
    const target = resolveIssueLinkTarget({
      url: "https://github.example.com:8443/acme/web/issues/7",
      projects: [
        enterprise("bare", "github.example.com"),
        enterprise("ported", "github.example.com:8443"),
      ],
    });
    expect(target?.ref.projectId).toBe("ported");

    // An Enterprise Server's hostname need not say "github"; its project vouches for it.
    const custom = resolveIssueLinkTarget({
      url: "https://code.acme.test/acme/web/issues/7",
      projects: [enterprise("custom", "code.acme.test")],
    });
    expect(custom?.ref).toMatchObject({ projectId: "custom", host: "code.acme.test", key: "7" });
  });

  it("reads a Linear issue through the project bound to its team, else lends a bound project", () => {
    const trackerBindings = {
      p1: { tracker: IssueTrackerKind.make("linear"), scope: "OPS" },
      p2: { tracker: IssueTrackerKind.make("linear"), scope: "ENG" },
    } as never;
    const own = resolveIssueLinkTarget({
      url: "https://linear.app/acme/issue/ENG-12/fix-the-thing",
      projects,
      trackerBindings,
    });
    expect(own?.ref).toEqual({
      projectId: "p2",
      tracker: "linear",
      host: "linear.app",
      scope: "ENG",
      key: "ENG-12",
    });

    const lent = resolveIssueLinkTarget({
      url: "https://linear.app/acme/issue/WEB-3",
      projects,
      trackerBindings,
      preferredProjectId: ProjectId.make("p2"),
    });
    expect(lent?.ref).toMatchObject({ projectId: "p2", scope: "WEB", key: "WEB-3" });
  });

  it.each([
    "https://github.com.evil.example/acme/web/issues/7",
    "https://github.com/acme/web/pull/7",
    "https://linear.app/acme/issue/ENG-12",
  ])("leaves %s an ordinary link", (url) => {
    expect(resolveIssueLinkTarget({ url, projects })).toBeNull();
  });
});

describe("linksAnotherLinearWorkspace", () => {
  it.each([
    {
      link: "https://linear.app/acme/issue/ENG-12",
      issue: "https://linear.app/acme/issue/ENG-12/a-title",
      expected: false,
    },
    {
      link: "https://linear.app/other/issue/ENG-12",
      issue: "https://linear.app/acme/issue/ENG-12/a-title",
      expected: true,
    },
    { link: "https://linear.app/acme/issue/ENG-12", issue: "not a url", expected: true },
    {
      link: "https://github.com/acme/web/issues/7",
      issue: "https://github.com/acme/web/issues/7",
      expected: false,
    },
  ])("$link opening $issue is another workspace's: $expected", ({ link, issue, expected }) => {
    expect(linksAnotherLinearWorkspace(link, issue)).toBe(expected);
  });
});

describe("isLinearIssueLink", () => {
  it.each([
    { url: "https://linear.app/acme/issue/ENG-12/a-title", expected: true },
    { url: "https://linear.app/acme/project/roadmap", expected: false },
    { url: "https://docs.example.com/guide", expected: false },
    { url: "not a url", expected: false },
  ])("$url is a Linear issue link: $expected", ({ url, expected }) => {
    expect(isLinearIssueLink(url)).toBe(expected);
  });
});

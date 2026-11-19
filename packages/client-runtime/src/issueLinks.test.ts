import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveIssueLinkTarget } from "./issueLinks.ts";

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

  it("reads a Linear link through the project bound to its team, else any bound to Linear", () => {
    const trackers = {
      trackers: [
        {
          tracker: IssueTrackerKind.make("linear"),
          displayName: "Linear",
          host: "linear.app",
          scopeNoun: "team",
          credential: { label: "Personal API key", helpUrl: null },
          connected: true,
          account: "julius",
          detail: null,
          workspace: "acme",
          scopes: [],
        },
      ],
      bindings: {
        [ProjectId.make("p1")]: { tracker: IssueTrackerKind.make("linear"), scope: "API" },
        [ProjectId.make("p2")]: { tracker: IssueTrackerKind.make("linear"), scope: "WEB" },
      },
    };
    const resolve = (url: string) => resolveIssueLinkTarget({ url, projects, trackers });
    expect(resolve("https://linear.app/acme/issue/WEB-17/fix-it")?.ref).toEqual({
      projectId: "p2",
      tracker: "linear",
      host: "linear.app",
      scope: "WEB",
      key: "WEB-17",
    });
    expect(resolve("https://linear.app/acme/issue/OPS-3")?.ref).toMatchObject({
      projectId: "p1",
      scope: "OPS",
      key: "OPS-3",
    });
    expect(resolve("https://linear.app.evil.example/acme/issue/WEB-17")).toBeNull();
    // Team keys repeat across workspaces; only the connected one's links are its issues.
    expect(resolve("https://linear.app/othercorp/issue/WEB-17")).toBeNull();
    expect(
      resolveIssueLinkTarget({ url: "https://linear.app/acme/issue/WEB-17", projects }),
    ).toBeNull();
  });

  it("reads a Jira link only on the connected site", () => {
    const trackers = {
      trackers: [
        {
          tracker: IssueTrackerKind.make("jira"),
          displayName: "Jira",
          host: "atlassian.net",
          scopeNoun: "project",
          credential: { label: "API token", helpUrl: null },
          connected: true,
          account: "Julius",
          detail: null,
          workspace: "acme",
          scopes: [],
        },
      ],
      bindings: {
        [ProjectId.make("p1")]: { tracker: IssueTrackerKind.make("jira"), scope: "ENG" },
      },
    };
    const resolve = (url: string) => resolveIssueLinkTarget({ url, projects, trackers });
    expect(resolve("https://acme.atlassian.net/browse/ENG-4")?.ref).toEqual({
      projectId: "p1",
      tracker: "jira",
      host: "atlassian.net",
      scope: "ENG",
      key: "ENG-4",
    });
    // Project keys repeat across sites; only the connected one's links are its issues.
    expect(resolve("https://othercorp.atlassian.net/browse/ENG-4")).toBeNull();
    expect(resolve("https://acme.atlassian.net.evil.example/browse/ENG-4")).toBeNull();
  });

  it.each([
    "https://github.com.evil.example/acme/web/issues/7",
    "https://github.com/acme/web/pull/7",
  ])("leaves %s an ordinary link", (url) => {
    expect(resolveIssueLinkTarget({ url, projects })).toBeNull();
  });
});

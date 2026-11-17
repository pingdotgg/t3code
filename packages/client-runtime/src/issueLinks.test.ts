import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveIssueLinkTarget } from "./issueLinks.ts";

const project = (id: string, repository: string) =>
  ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("env"),
    repositoryIdentity: {
      canonicalKey: `github.com/${repository}`,
      provider: SourceControlProviderKind.make("github"),
      webUrl: `https://github.com/${repository}`,
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

  it.each(["github.example.com", "github.example.com:8443"])(
    "prefers the configured authority with binding host %s over a preferred SSH project",
    (portedHost) => {
      const enterprise = (id: string, host: string, remoteUrl = `git@${host}:acme/web.git`) =>
        ({
          id: ProjectId.make(id),
          environmentId: EnvironmentId.make("env"),
          repositoryIdentity: {
            canonicalKey: `${host}/acme/web`,
            locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          },
        }) as never;
      const target = resolveIssueLinkTarget({
        url: "https://github.example.com:8443/acme/web/issues/7",
        preferredProjectId: "bare",
        projects: [
          enterprise("bare", "github.example.com"),
          enterprise("ported", portedHost, "https://github.example.com:8443/acme/web.git"),
        ],
      });
      expect(target?.ref).toMatchObject({ projectId: "ported", host: portedHost });
    },
  );

  it.each([
    "https://github.com:8443/acme/web/issues/7",
    "https://github.com.evil.example/acme/web/issues/7",
    "https://github.com/acme/web/pull/7",
  ])("leaves %s an ordinary link", (url) => {
    expect(resolveIssueLinkTarget({ url, projects })).toBeNull();
  });
});

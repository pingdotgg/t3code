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

  it.each(["github.example.com", "code.acme.test"])(
    "prefers the project bound to an issue link's own port on %s",
    (host) => {
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
        url: `https://${host}:8443/acme/web/issues/7`,
        projects: [enterprise("bare", host), enterprise("ported", `${host}:8443`)],
      });
      expect(target?.ref.projectId).toBe("ported");
    },
  );

  it.each([
    "https://github.com.evil.example/acme/web/issues/7",
    "https://github.com/acme/web/pull/7",
  ])("leaves %s an ordinary link", (url) => {
    expect(resolveIssueLinkTarget({ url, projects })).toBeNull();
  });
});

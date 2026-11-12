import {
  EnvironmentId,
  ProjectId,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  projectChangeRequestUrl,
  resolveChangeRequestLinkTarget,
  resolvePullRequestPreviewTarget,
} from "./changeRequestLinks.ts";

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: SourceControlProviderKind.make("gitlab"),
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

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: SourceControlProviderKind.make("github"),
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

describe("findProjectOnChangeRequestHost", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, repositoryIdentity: identity }) as never;
  const frontend = project("frontend", {
    canonicalKey: "github.com/acme/frontend",
    provider: "github",
    owner: "acme",
    name: "frontend",
  });
  const backend = project("backend", {
    canonicalKey: "github.com/acme/backend",
    provider: "github",
    owner: "acme",
    name: "backend",
  });

  it("prefers the project checked out from the link's own repository", () => {
    expect(
      findProjectOnChangeRequestHost([frontend, backend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(backend);
  });

  it("lends any project on the host to a repository nobody has checked out", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(frontend);
  });
});

describe("resolveChangeRequestLinkTarget", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const project = (id: string, environmentId: EnvironmentId, canonicalKey: string) => ({
    id: ProjectId.make(id),
    environmentId,
    repositoryIdentity: {
      canonicalKey,
      provider: SourceControlProviderKind.make(
        canonicalKey.startsWith("git.cafe") ? "gitcafe" : "github",
      ),
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
    } satisfies RepositoryIdentity,
  });
  const mirrored = project("mirrored", local, "git.cafe/acme/app");
  const sibling = project("sibling", local, "github.com/acme/tools");
  const elsewhere = project("elsewhere", remote, "github.com/acme/app");
  const projects = [mirrored, sibling, elsewhere];
  const loaded = () => true;
  const url = "https://github.com/acme/app/pull/7";

  it("opens a mirror's link in its own environment under a project on the link's host", () => {
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: loaded,
        environmentId: local,
        projectId: mirrored.id,
        lendHostProject: true,
      }),
    ).toEqual({ project: sibling, host: "github.com", repository: "acme/app", number: 7 });
  });

  it("only borrows a host project for views that can show any repository on the host", () => {
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: loaded,
        environmentId: local,
        lendHostProject: false,
      }),
    ).toBeNull();
  });

  it("finds the checked-out repository in any environment that reads change requests", () => {
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: loaded,
        primaryEnvironmentId: local,
        lendHostProject: false,
      })?.project,
    ).toBe(elsewhere);
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: (environmentId) => environmentId !== remote,
        lendHostProject: false,
      }),
    ).toBeNull();
  });
});

describe("resolvePullRequestPreviewTarget", () => {
  const environmentId = EnvironmentId.make("env-1");
  const project = {
    id: ProjectId.make("project-1"),
    environmentId,
    repositoryIdentity: {
      canonicalKey: "github.com/acme/web",
      provider: SourceControlProviderKind.make("github"),
      displayName: "acme/web",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/web" },
    } satisfies RepositoryIdentity,
  };

  it("previews a pull request only under the project that holds its repository", () => {
    const target = (url: string) =>
      resolvePullRequestPreviewTarget({
        environmentId,
        projects: [project],
        pullRequestsEnabled: true,
        url,
      });
    expect(target("https://github.com/acme/web/pull/7")).toEqual({
      environmentId,
      input: { projectId: project.id, host: "github.com", repository: "acme/web", number: 7 },
    });
    expect(target("https://github.com/acme/other/pull/7")).toBeNull();
  });
});

describe("projectChangeRequestUrl", () => {
  const identity = (provider: string): RepositoryIdentity => ({
    canonicalKey: "github.com/acme/default",
    provider: SourceControlProviderKind.make(provider),
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/default",
    },
  });

  it("builds the requested repository's URL on the project's host", () => {
    expect(projectChangeRequestUrl(identity("github"), "acme/other", 42)).toBe(
      "https://github.com/acme/other/pull/42",
    );
  });

  it("builds the project's own Azure repository from its full path, not its short selector", () => {
    const azure: RepositoryIdentity = {
      canonicalKey: "dev.azure.com/org/project/_git/web",
      provider: SourceControlProviderKind.make("azure-devops"),
      owner: "org",
      name: "web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://dev.azure.com/org/project/_git/web",
      },
    };
    expect(projectChangeRequestUrl(azure, "web", 42)).toBe(
      "https://dev.azure.com/org/project/_git/web/pullrequest/42",
    );
  });

  it("builds nothing without a project host that knows its URL shape", () => {
    expect(projectChangeRequestUrl(null, "acme/repository", 1)).toBeNull();
    expect(projectChangeRequestUrl(identity("unknown"), "acme/repository", 1)).toBeNull();
    const { provider: _provider, ...withoutProvider } = identity("github");
    expect(projectChangeRequestUrl(withoutProvider, "acme/repository", 1)).toBeNull();
  });
});

import {
  SourceControlProviderKind,
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignRepositoriesToEnvironments,
  resolveRepositoryCopies,
  type RepositoryProject,
} from "./workspaceRepositoryAssignment.logic";

const identity = (canonicalKey: string, rootPath?: string): RepositoryIdentity => {
  const [, ...path] = canonicalKey.split("/");
  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
    provider: SourceControlProviderKind.make(
      canonicalKey.startsWith("gitlab.") ? "gitlab" : "github",
    ),
    displayName: path.join("/"),
    ...(rootPath === undefined ? {} : { rootPath }),
  };
};

const rooted = (id: string, environmentId: string, canonicalKey: string): RepositoryProject => ({
  id: id as ProjectId,
  environmentId: environmentId as EnvironmentId,
  workspaceRoot: `/srv/${environmentId}/${id}`,
  repositoryIdentity: identity(canonicalKey),
});

/** A folder that is no repository, holding a checkout of each repository named. */
const workspace = (
  id: string,
  environmentId: string,
  ...canonicalKeys: ReadonlyArray<string>
): RepositoryProject => ({
  id: id as ProjectId,
  environmentId: environmentId as EnvironmentId,
  workspaceRoot: `/srv/${environmentId}/${id}`,
  repositoryIdentity: null,
  workspaceRepositories: canonicalKeys.map((key) =>
    identity(key, `/srv/${environmentId}/${id}/${key.split("/").at(-1)}`),
  ),
});

const envs = (...ids: ReadonlyArray<string>) => ids as ReadonlyArray<EnvironmentId>;
const plain = (assignment: ReturnType<typeof assignRepositoriesToEnvironments>) =>
  Object.fromEntries(assignment);

describe("assignRepositoriesToEnvironments", () => {
  it("lists each shared checkout from one Sandbox and the rest from their own", () => {
    // Numbered Sandboxes of one kind, each holding the same checkout plus one of its own.
    const assignment = assignRepositoriesToEnvironments(
      [
        workspace("w1", "env-1", "github.com/acme/studio", "github.com/acme/one"),
        workspace("w2", "env-2", "github.com/acme/studio", "github.com/acme/two"),
        workspace("w3", "env-3", "github.com/acme/studio"),
      ],
      envs("env-1", "env-2", "env-3"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({
      "env-1": { projectIds: ["w1"], excludeRepositories: [] },
      "env-2": { projectIds: ["w2"], excludeRepositories: ["github.com/acme/studio"] },
    });
  });

  it("weighs a folder's checkout and a project rooted in the repository alike", () => {
    const assignment = assignRepositoriesToEnvironments(
      [
        rooted("a1", "env-1", "github.com/acme/app"),
        workspace("w2", "env-2", "github.com/acme/app", "github.com/acme/tools"),
        rooted("a3", "env-3", "github.com/acme/app"),
      ],
      envs("env-1", "env-2", "env-3"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({
      "env-1": { projectIds: ["a1"], excludeRepositories: [] },
      "env-2": { projectIds: ["w2"], excludeRepositories: ["github.com/acme/app"] },
    });
  });

  it("lists a shared repository from a connected Sandbox while the first is stopped", () => {
    const projects = [
      workspace("w1", "env-1", "github.com/acme/studio"),
      workspace("w2", "env-2", "github.com/acme/studio"),
    ];
    const assignment = assignRepositoriesToEnvironments(
      projects,
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
      undefined,
      new Set(envs("env-1")),
    );
    expect(plain(assignment)).toEqual({
      "env-2": { projectIds: ["w2"], excludeRepositories: [] },
    });
  });

  it("lists a folder's checkout from a server whose host has a provider set up", () => {
    const projects = [
      workspace("w1", "env-1", "github.com/acme/studio", "gitlab.com/acme/tools"),
      workspace("w2", "env-2", "gitlab.com/acme/tools"),
    ];
    const hosts = (configured: boolean) => ({
      hosts: new Map([["gitlab.com", { configured, observedAt: 1 }]]),
      projectHosts: new Map(),
    });
    const assignment = assignRepositoriesToEnvironments(
      projects,
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
      new Map([
        ["env-1" as EnvironmentId, hosts(false)],
        ["env-2" as EnvironmentId, hosts(true)],
      ]),
    );
    expect(plain(assignment)).toEqual({
      "env-1": { projectIds: ["w1"], excludeRepositories: ["gitlab.com/acme/tools"] },
      "env-2": { projectIds: ["w2"], excludeRepositories: [] },
    });
  });

  it("lets the preferred server list a repository it isn't first to hold", () => {
    const assignment = assignRepositoriesToEnvironments(
      [
        workspace("w1", "env-1", "github.com/acme/studio"),
        workspace("w2", "env-2", "github.com/acme/studio"),
      ],
      envs("env-1", "env-2"),
      "env-2" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({
      "env-2": { projectIds: ["w2"], excludeRepositories: [] },
    });
  });

  it("reads one repository's remotes as one however they are written", () => {
    const assignment = assignRepositoriesToEnvironments(
      [
        workspace("w1", "env-1", "dev.azure.com/org/project/_git/web"),
        workspace("w2", "env-2", "ssh.dev.azure.com/v3/org/project/web"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({
      "env-1": { projectIds: ["w1"], excludeRepositories: [] },
    });
  });
});

describe("resolveRepositoryCopies", () => {
  const environments = ["env-1", "env-2", "env-3"].map((id) => ({
    environmentId: id as EnvironmentId,
    label: id,
  }));

  it("offers every Sandbox's checkout of a folder's repository, the panel's own first", () => {
    const copies = resolveRepositoryCopies(
      {
        environmentId: "env-1" as EnvironmentId,
        projectId: "w1" as ProjectId,
        host: "github.com",
        repository: "Acme/Studio",
      },
      [
        workspace("w1", "env-1", "github.com/acme/studio", "github.com/acme/one"),
        workspace("w2", "env-2", "github.com/acme/studio"),
        rooted("a3", "env-3", "github.com/acme/studio"),
      ],
      environments,
    );
    expect(
      copies.map(({ environmentId, workspaceRoot }) => [environmentId, workspaceRoot]),
    ).toEqual([
      ["env-1", "/srv/env-1/w1/studio"],
      ["env-2", "/srv/env-2/w2/studio"],
      ["env-3", "/srv/env-3/a3"],
    ]);
  });

  it("matches the folder's checkout exactly, on the pull request's host", () => {
    const current = {
      environmentId: "env-1" as EnvironmentId,
      projectId: "w1" as ProjectId,
      host: "gitlab.com",
      repository: "acme/app",
    };
    const other = workspace("w2", "env-2", "gitlab.com/acme/app");
    // A nested group whose path ends the same way, and the same path on another host.
    expect(
      resolveRepositoryCopies(
        current,
        [workspace("w1", "env-1", "gitlab.com/x/acme/app", "github.com/acme/app"), other],
        environments,
      ),
    ).toEqual([]);
    expect(
      resolveRepositoryCopies(
        current,
        [workspace("w1", "env-1", "gitlab.com/acme/app"), other],
        environments,
      ).map(({ environmentId }) => environmentId),
    ).toEqual(["env-1", "env-2"]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  CommandId,
  SourceControlDiscoveryResult,
  SourceControlProviderAuthStatus,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  addProjectRemoteTargetLabel,
  addProjectRemoteTargetReadiness,
  buildAddProjectRemoteSourceReadiness,
  buildAddProjectRemoteTargets,
  buildProjectCreateCommand,
  canCreateProjectInEnvironment,
  findExistingAddProject,
  getAddProjectInitialQuery,
  resolveAddProjectPath,
  sortAddProjectProviderSources,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

function providerItem(overrides: {
  readonly kind: SourceControlProviderKind;
  readonly id: string;
  readonly host?: string;
  readonly label?: string;
  readonly status?: "available" | "missing";
  readonly installHint?: string;
  readonly auth?: {
    readonly status?: SourceControlProviderAuthStatus;
    readonly account?: string;
    readonly host?: string;
    readonly detail?: string;
  };
}): SourceControlProviderDiscoveryItem {
  return {
    kind: overrides.kind,
    id: overrides.id,
    host: overrides.host ? Option.some(overrides.host) : Option.none(),
    label: overrides.label ?? overrides.kind,
    status: overrides.status ?? "available",
    version: Option.none(),
    installHint: overrides.installHint ?? "Install",
    detail: Option.none(),
    auth: {
      status: overrides.auth?.status ?? "authenticated",
      account: overrides.auth?.account ? Option.some(overrides.auth.account) : Option.none(),
      host: overrides.auth?.host ? Option.some(overrides.auth.host) : Option.none(),
      detail: overrides.auth?.detail ? Option.some(overrides.auth.detail) : Option.none(),
    },
  };
}

function discoveryResult(
  providers: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): SourceControlDiscoveryResult {
  return { versionControlSystems: [], sourceControlProviders: providers };
}

describe("add project shared logic", () => {
  it("only allows project creation in connected environments", () => {
    expect(canCreateProjectInEnvironment("connected")).toBe(true);
    expect(canCreateProjectInEnvironment("available")).toBe(false);
    expect(canCreateProjectInEnvironment("offline")).toBe(false);
    expect(canCreateProjectInEnvironment("connecting")).toBe(false);
    expect(canCreateProjectInEnvironment("reconnecting")).toBe(false);
    expect(canCreateProjectInEnvironment("error")).toBe(false);
  });

  it("resolves initial browse paths from settings", () => {
    expect(getAddProjectInitialQuery("")).toBe("~/");
    expect(getAddProjectInitialQuery("/work")).toBe("/work/");
    expect(getAddProjectInitialQuery("C:\\work")).toBe("C:\\work\\");
  });

  it("rejects unsupported windows paths on non-windows environments", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "C:\\repo",
        platform: "MacIntel",
        currentProjectCwd: null,
      }),
    ).toEqual({
      ok: false,
      error: "Windows-style paths are only supported on Windows environments.",
    });
  });

  it("resolves relative paths from the active project cwd", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "../next",
        platform: "Linux",
        currentProjectCwd: "/work/current",
      }),
    ).toEqual({ ok: true, path: "/work/next" });
  });

  it("marks authenticated source control providers as ready", () => {
    const discovery = discoveryResult([
      providerItem({
        kind: "github",
        id: "github",
        host: "github.com",
        label: "GitHub",
        installHint: "Install gh",
        auth: { status: "authenticated", account: "octo", host: "github.com" },
      }),
      providerItem({
        kind: "gitlab",
        id: "gitlab",
        host: "gitlab.com",
        label: "GitLab",
        installHint: "Install glab",
        auth: { status: "unauthenticated", detail: "Run glab auth login" },
      }),
    ]);

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);
    const targets = buildAddProjectRemoteTargets(discovery);
    expect(readiness.get("url")).toEqual({ ready: true, hint: null });
    expect(readiness.get("github")).toEqual({ ready: true, hint: null });
    expect(readiness.get("gitlab")).toEqual({ ready: false, hint: "Run glab auth login" });
    expect(sortAddProjectProviderSources(readiness, targets)[0]!.id).toBe("github");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });

  it("builds the existing project.create command shape", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/work/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "project.create",
      commandId: "command",
      projectId: "project",
      title: "repo",
      workspaceRoot: "/work/repo",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
    });
  });
});

describe("buildAddProjectRemoteTargets", () => {
  it("returns url plus one target per discovered connection", () => {
    const targets = buildAddProjectRemoteTargets(
      discoveryResult([
        providerItem({ kind: "github", id: "github", host: "github.com" }),
        providerItem({
          kind: "github-enterprise",
          id: "github-enterprise:git.corp.com",
          host: "git.corp.com",
          label: "git.corp.com",
        }),
      ]),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "url",
      "github",
      "github-enterprise:git.corp.com",
    ]);
    expect(targets[2]!.host).toBe("git.corp.com");
    expect(targets[2]!.source).toBe("github-enterprise");
  });

  it("leaves the host off non-enterprise targets", () => {
    const targets = buildAddProjectRemoteTargets(
      discoveryResult([
        providerItem({ kind: "github", id: "github", host: "github.com" }),
        providerItem({ kind: "gitlab", id: "gitlab", host: "gitlab.com" }),
        providerItem({ kind: "bitbucket", id: "bitbucket", host: "bitbucket.org" }),
        providerItem({ kind: "azure-devops", id: "azure-devops", host: "dev.azure.com" }),
      ]),
    );

    expect(targets.map((target) => ({ id: target.id, host: target.host }))).toEqual([
      { id: "url", host: null },
      { id: "github", host: null },
      { id: "gitlab", host: null },
      { id: "bitbucket", host: null },
      { id: "azure-devops", host: null },
    ]);
  });

  it("labels an enterprise target with its host", () => {
    expect(
      addProjectRemoteTargetLabel({
        id: "github-enterprise:git.corp.com",
        source: "github-enterprise",
        host: "git.corp.com",
      }),
    ).toBe("git.corp.com");
  });

  it("keys readiness by target id", () => {
    const discovery = discoveryResult([
      providerItem({
        kind: "github-enterprise",
        id: "github-enterprise:git.corp.com",
        host: "git.corp.com",
        auth: { status: "unauthenticated", detail: "Run gh auth login." },
      }),
    ]);

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);

    expect(readiness.get("github-enterprise:git.corp.com")).toEqual({
      ready: false,
      hint: "Run gh auth login.",
    });
    expect(readiness.get("url")).toEqual({ ready: true, hint: null });
  });

  it("still lists the four base providers, unready, when discovery is unavailable", () => {
    const targets = buildAddProjectRemoteTargets(null);
    const readiness = buildAddProjectRemoteSourceReadiness(null);
    const sorted = sortAddProjectProviderSources(readiness, targets);

    expect(sorted.map((target) => target.id)).toEqual([
      "azure-devops",
      "bitbucket",
      "github",
      "gitlab",
    ]);
    for (const target of sorted) {
      expect(addProjectRemoteTargetReadiness(readiness, target.id)).toEqual({
        ready: false,
        hint: "Provider status unavailable. Open Source Control settings and rescan.",
      });
    }
  });

  it("lists exactly the four base providers when discovery has no enterprise rows", () => {
    const discovery = discoveryResult([
      providerItem({ kind: "github", id: "github", host: "github.com" }),
      providerItem({ kind: "gitlab", id: "gitlab", host: "gitlab.com" }),
      providerItem({ kind: "bitbucket", id: "bitbucket", host: "bitbucket.org" }),
      providerItem({ kind: "azure-devops", id: "azure-devops", host: "dev.azure.com" }),
    ]);
    const targets = buildAddProjectRemoteTargets(discovery);
    const readiness = buildAddProjectRemoteSourceReadiness(discovery);
    const sorted = sortAddProjectProviderSources(readiness, targets);

    expect(sorted.map((target) => target.id)).toEqual([
      "azure-devops",
      "bitbucket",
      "github",
      "gitlab",
    ]);
  });
});

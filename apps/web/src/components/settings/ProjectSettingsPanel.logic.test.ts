import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  projectGroupTitleNeedsUpdate,
  scopeProjectSettingsGroup,
} from "./ProjectSettingsPanel.logic";

const localEnvironmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const customIcon = { kind: "lucide", name: "cloud", color: "red" } as const;

function makeProject(environmentId: EnvironmentId, overrides: Partial<Project> = {}): Project {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}-project`),
    title: "repo",
    workspaceRoot: `/${environmentId}/repo`,
    repositoryIdentity: {
      canonicalKey: "github.com/owner/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/owner/repo.git",
      },
      provider: "github",
      owner: "owner",
      name: "repo",
      displayName: "owner/repo",
    },
    defaultModelSelection: null,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function projectGroup(projects: Project[]) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: localEnvironmentId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
}

describe("scopeProjectSettingsGroup", () => {
  it("keeps the sidebar icon when the remote checkout was registered first", () => {
    const group = projectGroup([
      makeProject(remoteEnvironmentId),
      makeProject(localEnvironmentId, { projectIcon: customIcon }),
    ]);
    const scoped = scopeProjectSettingsGroup(group, group.memberProjects);

    expect(scoped.environmentId).toBe(localEnvironmentId);
    expect(scoped.projectIcon).toEqual(customIcon);
    expect(scoped.memberProjects).toHaveLength(2);
    expect(scoped.memberProjects[0]?.projectIcon).toBeNull();
  });

  it("keeps the favicon source and automatic title with the sidebar representative", () => {
    const group = projectGroup([
      makeProject(remoteEnvironmentId, { title: "Remote repo", faviconPath: "remote.svg" }),
      makeProject(localEnvironmentId, { title: "Local repo", faviconPath: "local.svg" }),
    ]);
    const scoped = scopeProjectSettingsGroup(group, group.memberProjects);

    expect(scoped).toMatchObject({
      environmentId: localEnvironmentId,
      workspaceRoot: "/local/repo",
      title: "Local repo",
      faviconPath: "local.svg",
    });
  });

  it("uses the selected environment when it excludes the sidebar representative", () => {
    const group = projectGroup([
      makeProject(remoteEnvironmentId, { faviconPath: "remote.svg" }),
      makeProject(localEnvironmentId, { projectIcon: customIcon }),
    ]);
    const members = group.memberProjects.filter(
      (member) => member.environmentId === remoteEnvironmentId,
    );
    const scoped = scopeProjectSettingsGroup(group, members);

    expect(scoped).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: "remote-project",
      workspaceRoot: "/remote/repo",
      faviconPath: "remote.svg",
      projectIcon: null,
    });
    expect(scoped.memberProjects).toHaveLength(1);
    expect(group.projectIcon).toEqual(customIcon);
  });

  it("uses the selected physical checkout among siblings on the same environment", () => {
    const group = projectGroup([
      makeProject(localEnvironmentId, { projectIcon: customIcon }),
      makeProject(localEnvironmentId, {
        id: ProjectId.make("other-checkout"),
        workspaceRoot: "/local/other-repo",
        projectIcon: { kind: "emoji", emoji: "🐦" },
      }),
    ]);
    const members = group.memberProjects.filter((member) => member.id === "other-checkout");
    const scoped = scopeProjectSettingsGroup(group, members);

    expect(scoped).toMatchObject({
      environmentId: localEnvironmentId,
      id: "other-checkout",
      workspaceRoot: "/local/other-repo",
      projectIcon: { kind: "emoji", emoji: "🐦" },
    });
    expect(scoped.memberProjects).toHaveLength(1);
  });
});

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

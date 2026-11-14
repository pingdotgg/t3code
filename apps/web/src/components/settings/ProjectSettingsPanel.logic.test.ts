import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, SourceControlProviderKind, ThreadId } from "@t3tools/contracts";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";

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
      provider: SourceControlProviderKind.make("github"),
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
  it("keeps the sidebar preview identity and edit targets when the remote checkout was registered first", () => {
    const local = makeProject(localEnvironmentId, {
      title: "Local repo",
      faviconPath: "local.svg",
      projectIcon: customIcon,
    });
    const remote = makeProject(remoteEnvironmentId, {
      title: "Remote repo",
      faviconPath: "remote.svg",
    });
    const group = projectGroup([remote, local]);
    const scoped = scopeProjectSettingsGroup(group, group.memberProjects);

    expect(group).toMatchObject(local);
    expect(scoped).toMatchObject(local);
    expect(scoped.memberProjects).toBe(group.memberProjects);
    expect(scoped.memberProjects).toMatchObject([remote, local]);
  });

  it.each([
    [remoteEnvironmentId, "local-project"],
    [localEnvironmentId, "other-checkout"],
  ])("uses the complete selected checkout identity for %s/%s", (environmentId, id) => {
    const local = makeProject(localEnvironmentId, { projectIcon: customIcon });
    const selected = makeProject(environmentId, {
      id: ProjectId.make(id),
      title: "Selected checkout",
      workspaceRoot: "/selected/repo",
      faviconPath: "selected.svg",
      projectIcon: null,
    });
    const group = projectGroup([local, selected]);
    const members = group.memberProjects.filter(
      (member) => member.environmentId === selected.environmentId && member.id === selected.id,
    );
    const scoped = scopeProjectSettingsGroup(group, members);

    expect(scoped).toMatchObject(selected);
    expect(scoped.memberProjects).toBe(members);
    expect(scoped.memberProjects).toMatchObject([selected]);
    expect(group).toMatchObject(local);
  });
});

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  const parentId = ThreadId.make("parent");
  const listed = { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null };
  const child = { rootThreadId: parentId, parentThreadId: parentId };

  it("limits a checkout's thread count to its listed threads in that environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        { environmentId: local.environmentId, projectId: local.id, lineage: listed },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "subagent" },
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "fork", sideChat: true },
        },
        { environmentId: remote.environmentId, projectId: remote.id, lineage: listed },
      ],
    });
    expect(plan.projectThreads).toHaveLength(3);
    expect(plan.confirmationMessage).toBe(
      'Remove checkout "Repo" and delete its 1 thread?\nPath: /work/repo\nEnvironment: Local\nThose threads and any archived threads are deleted from T3 Code. Provider sessions are kept.\nOther entries in this grouped project are unaffected.\nThis action cannot be undone.',
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain(
      "Other entries in this grouped project are unaffected.",
    );
    expect(plan.confirmationMessage).toContain(
      "Any archived threads are deleted from T3 Code. Provider sessions are kept.",
    );
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.confirmationMessage).toContain("This removes 2 grouped project entries.");
    expect(plan.confirmationMessage).toContain(
      "This removes only the project entries, not the files on disk.",
    );
  });
});

describe("projectGroupTitleNeedsUpdate", () => {
  const folderTitle = { title: "repo" };
  const renamed = { title: "repo", hasCustomTitle: true };

  // regression: #15049 renaming to the default folder title was never saved
  it("saves a title that matches the folder default so the rename is recorded", () => {
    expect(projectGroupTitleNeedsUpdate([folderTitle, folderTitle], "repo", true)).toBe(true);
  });

  it("skips untouched fields and renames every member already carries", () => {
    expect(projectGroupTitleNeedsUpdate([folderTitle, { title: "other" }], "repo", false)).toBe(
      false,
    );
    expect(projectGroupTitleNeedsUpdate([renamed, renamed], "repo", true)).toBe(false);
  });
});

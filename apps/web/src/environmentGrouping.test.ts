import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  getProjectOrderKey,
  resolveProjectGroupingMode,
} from "./logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKey,
  getSidebarProjectSettingsKey,
} from "./sidebarProjectGrouping";
import { orderItemsByPreferredIds } from "./components/Sidebar.logic";
import { legacyProjectCwdPreferenceKey } from "./uiStateStore";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const defaultGroupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("environment grouping", () => {
  it("opens physical scratch settings from the merged filter, including a remote thread target", () => {
    const local = makeProject({
      title: "No project",
      workspaceRoot: "/local/scratch",
      isScratch: true,
    });
    const remote = makeProject({
      title: "No project",
      id: ProjectId.make("remote-scratch"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/remote/scratch",
      isScratch: true,
    });
    const input = {
      projects: [local, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    };
    const filters = buildSidebarProjectSnapshots({ ...input, groupScratchProjects: true });
    const settingsGroups = buildSidebarProjectSnapshots(input);
    expect(filters).toHaveLength(1);
    expect(settingsGroups).toHaveLength(2);
    expect(settingsGroups.map((group) => group.memberProjectRefs)).toEqual([
      [{ environmentId: local.environmentId, projectId: local.id }],
      [{ environmentId: remote.environmentId, projectId: remote.id }],
    ]);
    expect(getSidebarProjectSettingsKey(filters[0]!, defaultGroupingSettings, input.projects)).toBe(
      settingsGroups[0]?.projectKey,
    );
    expect(
      getSidebarProjectSettingsKey(filters[0]!, defaultGroupingSettings, input.projects, {
        environmentId: remote.environmentId,
        projectId: remote.id,
      }),
    ).toBe(settingsGroups[1]?.projectKey);
  });

  it.each(["repository", "repository_path"] as const)(
    "migrates a scratch scope selected before config in %s mode",
    (mode) => {
      const project = makeProject({
        workspaceRoot: "/repo/scratch",
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/repo" },
      });
      const settings = { ...defaultGroupingSettings, sidebarProjectGroupingMode: mode };
      const key = deriveLogicalProjectKeyFromSettings(project, settings);
      const groups = buildSidebarProjectSnapshots({
        projects: [{ ...project, isScratch: true }],
        groupScratchProjects: true,
        settings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      });
      expect(
        resolveSidebarProjectScopeKey({ groups, key, settings, canClearMissingScope: true }),
      ).toBe(groups[0]?.projectKey);
    },
  );

  it("prefers an existing ordinary repository scope over a scratch alias", () => {
    const scratch = makeProject({ isScratch: true, repositoryIdentity });
    const ordinary = makeProject({
      id: ProjectId.make("ordinary"),
      workspaceRoot: "/ordinary",
      repositoryIdentity,
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [scratch, ordinary],
      groupScratchProjects: true,
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const key = deriveLogicalProjectKeyFromSettings(ordinary, defaultGroupingSettings);
    expect(resolveSidebarProjectScopeKey({ groups, key, canClearMissingScope: true })).toBe(key);
  });

  it("keeps both scratch hosts in one filter and migrates a physical scope after config loads", () => {
    const projects = [
      makeProject({ title: "No project", workspaceRoot: "/local/scratch" }),
      makeProject({
        id: ProjectId.make("scratch-remote"),
        environmentId: remoteEnvironmentId,
        title: "No project",
        workspaceRoot: "/remote/scratch",
      }),
    ];
    const build = (scratch: boolean) =>
      buildSidebarProjectSnapshots({
        projects: projects.map((project) => ({
          ...project,
          ...(scratch ? { isScratch: true as const } : {}),
        })),
        groupScratchProjects: true,
        settings: defaultGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (id) => id,
      });
    const oldKey = derivePhysicalProjectKey(projects[1]!);
    const unloaded = build(false);
    const groups = build(true);
    const scratchKey = groups[0]!.projectKey;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.displayName).toBe("No project");
    expect(groups[0]?.memberProjects).toHaveLength(2);
    expect(groups[0]?.memberProjectRefs).toEqual(
      projects.map((project) => ({ environmentId: project.environmentId, projectId: project.id })),
    );
    expect(resolveSidebarProjectScopeKey({ groups: unloaded, key: oldKey })).toBe(oldKey);
    expect(resolveSidebarProjectScopeKey({ groups, key: oldKey, canClearMissingScope: true })).toBe(
      scratchKey,
    );
    expect(resolveSidebarProjectScopeKey({ groups: unloaded, key: scratchKey })).toBe(scratchKey);
    expect(
      resolveSidebarProjectScopeKey({ groups, key: scratchKey, canClearMissingScope: true }),
    ).toBe(scratchKey);
    expect(
      resolveSidebarProjectScopeKey({ groups, key: "removed", canClearMissingScope: true }),
    ).toBeNull();
  });

  it("does not migrate an ordinary physical filter into a repository group", () => {
    const project = makeProject({ repositoryIdentity, title: "No project" });
    const groups = buildSidebarProjectSnapshots({
      projects: [project],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    expect(
      resolveSidebarProjectScopeKey({
        groups,
        key: derivePhysicalProjectKey(project),
        canClearMissingScope: true,
      }),
    ).toBeNull();
  });

  it("groups matching repository identities across environments", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(repositoryIdentity.canonicalKey);
    expect(deriveLogicalProjectKey(remote)).toBe(repositoryIdentity.canonicalKey);
  });

  it("counts cross-environment copies as one new-thread project choice", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const projectGroupCount = buildSidebarProjectSnapshots({
      projects: [primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    }).length;

    expect(projectGroupCount).toBe(1);
  });

  it("reports whether the project groups span more than one environment", () => {
    const grouped = makeProject({ repositoryIdentity });
    const groupedRemote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separateLocal = makeProject({
      id: ProjectId.make("workbench-local"),
      title: "workbench",
      workspaceRoot: "/tmp/workbench",
    });
    const separateRemote = makeProject({
      id: ProjectId.make("workbench-remote"),
      environmentId: remoteEnvironmentId,
      title: "workbench",
      workspaceRoot: "/tmp/workbench",
    });
    const build = (projects: Project[]) =>
      buildSidebarProjectSnapshots({
        projects,
        settings: defaultGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) =>
          environmentId === remoteEnvironmentId ? "Mac mini" : "Primary",
      });

    const groups = build([groupedRemote, grouped, separateLocal, separateRemote]);
    expect(groups).toHaveLength(3);
    expect(projectGroupsSpanEnvironments(groups)).toBe(true);
    expect(projectGroupsSpanEnvironments(build([grouped, separateLocal]))).toBe(false);
    expect(projectGroupsSpanEnvironments(build([separateRemote]))).toBe(false);
  });

  it("keeps projects without repository identity physically scoped", () => {
    const primary = makeProject();
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(derivePhysicalProjectKey(primary));
    expect(deriveLogicalProjectKey(remote)).toBe(derivePhysicalProjectKey(remote));
    expect(deriveLogicalProjectKey(primary)).not.toBe(deriveLogicalProjectKey(remote));
  });

  it("uses the physical key when repository grouping is disabled", () => {
    const project = makeProject({ repositoryIdentity });

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      }),
    ).toBe(derivePhysicalProjectKey(project));
  });

  it("allows a per-project override to separate an otherwise grouped repository", () => {
    const project = makeProject({ repositoryIdentity });
    const physicalKey = derivePhysicalProjectKey(project);

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        ...defaultGroupingSettings,
        sidebarProjectGroupingOverrides: {
          [physicalKey]: "separate",
        },
      }),
    ).toBe(physicalKey);
  });

  it("allows a per-project override to group a repository while the global mode is separate", () => {
    const project = makeProject({ repositoryIdentity });

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {
          [derivePhysicalProjectKey(project)]: "repository",
        },
      }),
    ).toBe(repositoryIdentity.canonicalKey);
  });

  it("reports the effective grouping mode after applying an override", () => {
    const project = makeProject({ repositoryIdentity });
    const physicalKey = derivePhysicalProjectKey(project);

    expect(resolveProjectGroupingMode(project, defaultGroupingSettings)).toBe("repository");
    expect(
      resolveProjectGroupingMode(project, {
        ...defaultGroupingSettings,
        sidebarProjectGroupingOverrides: {
          [physicalKey]: "separate",
        },
      }),
    ).toBe("separate");
  });

  it("dedupes stale project rows with the same environment and workspace path", () => {
    const duplicate = makeProject({
      id: ProjectId.make("project-duplicate"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const primary = makeProject({
      id: ProjectId.make("project-primary"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [primary, duplicate, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.groupedProjectCount).toBe(2);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      primary.id,
      remote.id,
    ]);
  });

  it("prefers the fresher project row when duplicate stale rows are ordered first", () => {
    const staleDuplicate = makeProject({
      id: ProjectId.make("project-stale"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleDuplicate, canonical],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([canonical.id]);
    expect(snapshots[0]?.id).toBe(canonical.id);
  });

  it("dedupes stale project rows before logical grouping", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleWithoutRepositoryIdentity, canonical, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      canonical.id,
      remote.id,
    ]);
    expect(snapshots[0]?.memberProjectRefs).toEqual([
      {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
      { environmentId: primaryEnvironmentId, projectId: canonical.id },
      { environmentId: remoteEnvironmentId, projectId: remote.id },
    ]);

    const [pickerEntry] = buildSidebarProjectPickerEntries({
      groups: snapshots,
      preferredProjectRef: {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
    });
    expect(pickerEntry?.isPreferred).toBe(true);
    expect(pickerEntry?.targetProject.id).toBe(canonical.id);
  });

  it("routes duplicate physical project keys to the winning logical group", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const physicalToLogicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects: [staleWithoutRepositoryIdentity, canonical],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
    });

    expect(physicalToLogicalKey.get(derivePhysicalProjectKey(staleWithoutRepositoryIdentity))).toBe(
      repositoryIdentity.canonicalKey,
    );
    // Deriving from the stale project alone misses the identity its sibling
    // carries, so consumers must go through the map to match the sidebar.
    expect(
      deriveLogicalProjectKeyFromSettings(staleWithoutRepositoryIdentity, defaultGroupingSettings),
    ).not.toBe(repositoryIdentity.canonicalKey);
  });

  it("builds one picker entry per logical project and targets the preferred environment", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [separate, primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: remote.id,
      },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.group.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: remote.id,
    });
    expect(entries[0]?.isPreferred).toBe(true);
    expect(entries[1]?.group.displayName).toBe("separate");
  });

  it("keeps the current environment when available and falls back otherwise", () => {
    const currentPrimary = makeProject({ repositoryIdentity });
    const currentRemote = makeProject({
      id: ProjectId.make("current-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const destinationRepositoryIdentity = {
      canonicalKey: "github.com/example/destination",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/destination.git",
      },
    };
    const destinationPrimary = makeProject({
      id: ProjectId.make("destination-primary"),
      title: "destination",
      workspaceRoot: "/tmp/destination",
      repositoryIdentity: destinationRepositoryIdentity,
    });
    const destinationRemote = makeProject({
      id: ProjectId.make("destination-remote"),
      environmentId: remoteEnvironmentId,
      title: "destination",
      workspaceRoot: "/remote/destination",
      repositoryIdentity: destinationRepositoryIdentity,
    });
    const fallbackPrimary = makeProject({
      id: ProjectId.make("fallback-primary"),
      title: "fallback",
      workspaceRoot: "/tmp/fallback",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [
        currentPrimary,
        currentRemote,
        destinationPrimary,
        destinationRemote,
        fallbackPrimary,
      ],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: currentRemote.id,
      },
    });
    const destination = entries.find(
      (entry) => entry.group.projectKey === destinationRepositoryIdentity.canonicalKey,
    );
    const fallback = entries.find((entry) => entry.group.displayName === "fallback");

    expect(destination?.targetProject).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: destinationRemote.id,
    });
    expect(fallback?.targetProject).toMatchObject({
      environmentId: primaryEnvironmentId,
      id: fallbackPrimary.id,
    });
  });

  it("keeps manual project order when building grouped sidebar entries", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const orderedProjects = orderItemsByPreferredIds({
      items: [primary, remote, separate],
      preferredIds: [getProjectOrderKey(separate), getProjectOrderKey(primary)],
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });

    const groups = buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(groups.map((group) => group.displayName)).toEqual(["separate", "shared-repo"]);
  });
});

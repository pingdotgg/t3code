import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
} from "@t3tools/client-runtime/state/project-grouping";
import { resolveSettingsProjectSearch } from "./components/settings/settingsScope";
import {
  buildSettingsProjectSnapshots,
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKey,
  getSidebarProjectSettingsKey,
} from "./sidebarProjectGrouping";
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
  it("groups No project across machines in settings", () => {
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
    const ordinary = makeProject({
      id: ProjectId.make("ordinary"),
      title: "No project",
      workspaceRoot: "/ordinary",
    });
    const input = {
      projects: [local, remote, ordinary],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    };
    const settingsGroups = buildSettingsProjectSnapshots(input);
    const scratch = settingsGroups.filter((group) => group.isScratch);
    expect(scratch).toHaveLength(1);
    expect(scratch[0]?.displayName).toBe("No project");
    expect(scratch[0]?.memberProjectRefs).toEqual([
      { environmentId: local.environmentId, projectId: local.id },
      { environmentId: remote.environmentId, projectId: remote.id },
    ]);
    expect(settingsGroups.filter((group) => !group.isScratch).map((group) => group.id)).toEqual([
      ordinary.id,
    ]);
    const sidebar = buildSidebarProjectSnapshots({ ...input, groupScratchProjects: true });
    expect(
      resolveSettingsProjectSearch(
        {
          project: getSidebarProjectSettingsKey(
            sidebar.find((group) => group.isScratch)!,
            defaultGroupingSettings,
            input.projects,
            { environmentId: remote.environmentId, projectId: remote.id },
          ),
        },
        settingsGroups,
        defaultGroupingSettings,
      ),
    ).toEqual({ project: scratch[0]?.projectKey });
    const remoteSearch = {
      project: getSidebarProjectSettingsKey(sidebar[0]!, defaultGroupingSettings, input.projects, {
        environmentId: remote.environmentId,
        projectId: remote.id,
      }),
    };
    expect(
      resolveSettingsProjectSearch(remoteSearch, settingsGroups, defaultGroupingSettings, true),
    ).toEqual({ project: scratch[0]?.projectKey, machine: remoteEnvironmentId });
    const narrowed = {
      project: getSidebarProjectSettingsKey(sidebar[0]!, defaultGroupingSettings, input.projects),
      machine: remoteEnvironmentId,
      checkout: scratch[0]!.memberProjects[1]!.physicalProjectKey,
    };
    expect(resolveSettingsProjectSearch(narrowed, settingsGroups, defaultGroupingSettings)).toEqual(
      {
        ...narrowed,
        project: scratch[0]?.projectKey,
      },
    );
    const missing = { project: "removed", machine: remoteEnvironmentId };
    expect(resolveSettingsProjectSearch(missing, settingsGroups, defaultGroupingSettings)).toBe(
      missing,
    );
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

  it("puts the preferred project after pinned projects", () => {
    const project = (title: string, pinnedAt: string | null = null) =>
      makeProject({
        id: ProjectId.make(title),
        title,
        workspaceRoot: `/tmp/${title}`,
        repositoryIdentity: null,
        pinnedAt,
      });
    const current = project("current");
    const groups = buildSidebarProjectSnapshots({
      projects: [project("other"), project("pinned", "2026-01-01T00:00:00.000Z"), current],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const entries = buildSidebarProjectPickerEntries({
      groups: pickableProjectGroups(groups),
      preferredProjectRef: { environmentId: current.environmentId, projectId: current.id },
    });
    expect(entries.map((entry) => entry.group.displayName)).toEqual(["pinned", "current", "other"]);
  });
});

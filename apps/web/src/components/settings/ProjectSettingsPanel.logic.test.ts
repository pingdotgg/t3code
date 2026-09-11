import { describe, expect, it } from "vite-plus/test";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "../../logicalProject";
import { legacyProjectCwdPreferenceKey, type UiProjectState } from "../../uiStateStore";

import {
  checkoutKey,
  projectGroupTitleNeedsUpdate,
  relinkProjectGroupingSettings,
  relinkProjectPreferences,
  resolveSettingsProjectGroup,
} from "./ProjectSettingsPanel.logic";

const identity = {
  canonicalKey: "github.com/example/repo",
  rootPath: "/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/repo.git",
  },
  provider: "github",
  owner: "example",
  name: "repo",
  displayName: "repo",
};

function navigationGroup(projectKey: string, member: { environmentId: string; id: string }) {
  const project = checkout(`/${projectKey}`, {
    environmentId: EnvironmentId.make(member.environmentId),
    id: ProjectId.make(member.id),
  });
  return {
    ...buildSidebarProjectSnapshots({
      projects: [project],
      settings: grouping("separate"),
      primaryEnvironmentId: null,
      resolveEnvironmentLabel: () => null,
    })[0]!,
    projectKey,
  };
}

function relinkProjectUiState(...args: Parameters<typeof relinkProjectPreferences>) {
  return relinkProjectPreferences(...args).uiState;
}

describe("checkout settings navigation", () => {
  const groups = [
    navigationGroup("original-group", { environmentId: "local", id: "remaining" }),
    navigationGroup("moved-group", { environmentId: "remote", id: "moved" }),
    navigationGroup("other-machine", { environmentId: "local", id: "moved" }),
  ];

  it("follows the relinked checkout even when its old group still exists", () => {
    expect(
      resolveSettingsProjectGroup(
        groups,
        "original-group",
        checkoutKey(groups[1]!.memberProjects[0]!),
      ),
    ).toBe(groups[1]);
  });

  it("scopes the checkout to its environment", () => {
    expect(
      resolveSettingsProjectGroup(
        groups,
        "original-group",
        checkoutKey(groups[2]!.memberProjects[0]!),
      ),
    ).toBe(groups[2]);
  });

  it("keeps separator-containing IDs distinct when following a checkout into another group", () => {
    const collidingGroups = [
      navigationGroup("old-group", { environmentId: "a", id: "b:c" }),
      navigationGroup("moved-group", { environmentId: "a:b", id: "c" }),
    ];
    const checkout = JSON.stringify(["a:b", "c"]);

    expect(resolveSettingsProjectGroup(collidingGroups, "old-group", checkout)).toBe(
      collidingGroups[1],
    );
    expect(resolveSettingsProjectGroup(collidingGroups.toReversed(), "old-group", checkout)).toBe(
      collidingGroups[1],
    );
  });

  it("keeps ordinary navigation and falls back when the requested checkout was removed", () => {
    const removedCheckout = checkoutKey({ environmentId: "remote", id: "deleted" });
    expect(resolveSettingsProjectGroup(groups, "original-group")).toBe(groups[0]);
    expect(resolveSettingsProjectGroup(groups, "original-group", removedCheckout)).toBe(groups[0]);
    expect(resolveSettingsProjectGroup(groups, "deleted-group", removedCheckout)).toBeNull();
  });

  it("does not interpret an ambiguous old checkout key as another environment", () => {
    const collidingGroups = [
      navigationGroup("first", { environmentId: "a", id: "b:c" }),
      navigationGroup("intended", { environmentId: "a:b", id: "c" }),
    ];
    expect(resolveSettingsProjectGroup(collidingGroups, "intended", "a:b:c")).toBe(
      collidingGroups[1],
    );
    expect(resolveSettingsProjectGroup(collidingGroups, "intended", "not-json")).toBe(
      collidingGroups[1],
    );
  });

  it.each([
    { environmentId: "a:b", id: "c" },
    { environmentId: 'a"b', id: "c\\d" },
    { environmentId: "123", id: "true" },
    { environmentId: "日本語/?&=#", id: "🧪 + %" },
  ])("keeps checkout $environmentId/$id selected through URL serialization", (member) => {
    const targetGroup = navigationGroup("target", member);
    const checkout = checkoutKey(member);
    const parsedSearch: Record<string, unknown> = defaultParseSearch(
      defaultStringifySearch({ checkout }),
    );
    const restoredCheckout =
      typeof parsedSearch.checkout === "string" ? parsedSearch.checkout : undefined;

    expect(restoredCheckout).toBe(checkout);
    expect(
      resolveSettingsProjectGroup([...groups, targetGroup], "original-group", restoredCheckout),
    ).toBe(targetGroup);
  });
});

function checkout(
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    id: ProjectId.make("project"),
    environmentId: EnvironmentId.make("environment"),
    title: "Project",
    workspaceRoot,
    repositoryIdentity: identity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function grouping(mode: ProjectGroupingSettings["sidebarProjectGroupingMode"]) {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides:
      {} as ProjectGroupingSettings["sidebarProjectGroupingOverrides"],
    pullRequestMergeMethodOverrides: {} as ClientSettings["pullRequestMergeMethodOverrides"],
  };
}

function collapsed(project: EnvironmentProject, settings: ProjectGroupingSettings): UiProjectState {
  const key = deriveLogicalProjectKeyFromSettings(project, settings);
  return {
    sidebarProjectScopeKey: key,
    projectExpandedById: { [key]: false },
    projectOrder: [derivePhysicalProjectKey(project)],
  };
}

describe("relinked checkout preferences", () => {
  it.each([null, identity])(
    "selects a hidden registration with identity %j by its exact project ID",
    (repositoryIdentity) => {
      const older = checkout("/missing", {
        id: ProjectId.make("conversation-project"),
        repositoryIdentity,
      });
      const newer = checkout("/missing", {
        id: ProjectId.make("newer-project"),
        updatedAt: "2026-09-06T00:00:00.000Z",
        autoPull: true,
      });
      const remote = checkout("/missing", {
        environmentId: EnvironmentId.make("remote"),
        id: older.id,
      });
      const projects = [older, newer, remote];
      const settings = grouping("repository");
      const groups = buildSidebarProjectSnapshots({
        projects,
        settings,
        primaryEnvironmentId: older.environmentId,
        resolveEnvironmentLabel: () => "Test machine",
      });
      expect(
        groups
          .flatMap((group) => group.memberProjects)
          .filter((project) => project.environmentId === older.environmentId)
          .map((project) => project.id),
      ).toEqual([newer.id]);
      const target = checkoutKey(older);
      const selected = resolveSettingsProjectGroup(
        groups,
        deriveLogicalProjectKeyFromSettings(older, settings),
        target,
        projects,
      );
      const selectedCheckout = selected?.memberProjects.find(
        (project) => checkoutKey(project) === target,
      );
      expect(selectedCheckout).toMatchObject({
        id: older.id,
        environmentId: older.environmentId,
        workspaceRoot: older.workspaceRoot,
      });
      expect(selectedCheckout?.autoPull).toBeUndefined();
      expect(selected?.memberProjectRefs.find((ref) => ref.projectId === newer.id)).toBeDefined();
      expect(selected?.memberProjects).toHaveLength(groups[0]!.memberProjects.length);
      expect(
        resolveSettingsProjectGroup(
          groups,
          "stale",
          checkoutKey(remote),
          projects,
        )?.memberProjects.find((project) => checkoutKey(project) === checkoutKey(remote)),
      ).toMatchObject(remote);
    },
  );

  it("carries the current merge method to a vanished group's successor", () => {
    const previous = checkout("/old");
    const project = checkout("/new");
    const settings = grouping("separate");
    const oldKey = deriveLogicalProjectKeyFromSettings(previous, settings);
    const newKey = deriveLogicalProjectKeyFromSettings(project, settings);
    settings.pullRequestMergeMethodOverrides = { [oldKey]: "rebase", unrelated: "squash" };
    const next = relinkProjectPreferences(collapsed(previous, settings), {
      previous,
      project,
      projects: [project],
      settings,
    });
    expect(next.settings.pullRequestMergeMethodOverrides).toEqual({
      [newKey]: "rebase",
      unrelated: "squash",
    });
    expect(settings.pullRequestMergeMethodOverrides[oldKey]).toBe("rebase");
  });

  it("preserves a duplicate registration's grouping and order when the targeted checkout moves", () => {
    const previous = checkout("/old", { id: ProjectId.make("older") });
    const remaining = checkout("/old", {
      id: ProjectId.make("newer"),
      updatedAt: "2026-09-06T00:00:00.000Z",
    });
    const project = { ...previous, workspaceRoot: "/new" };
    const settings = grouping("repository");
    const oldKey = derivePhysicalProjectKey(previous);
    const newKey = derivePhysicalProjectKey(project);
    settings.sidebarProjectGroupingOverrides = { [oldKey]: "separate" };
    settings.pullRequestMergeMethodOverrides = { [oldKey]: "rebase" };
    const state = { ...collapsed(previous, settings), projectOrder: ["first", oldKey, "last"] };
    const next = relinkProjectPreferences(state, {
      previous,
      project,
      projects: [remaining, project],
      settings,
    });
    expect(next.settings.sidebarProjectGroupingOverrides).toEqual({
      [oldKey]: "separate",
      [newKey]: "separate",
    });
    expect(next.settings.pullRequestMergeMethodOverrides).toEqual({ [oldKey]: "rebase" });
    expect(next.uiState.projectOrder).toEqual(["first", oldKey, newKey, "last"]);
    expect(next.uiState.sidebarProjectScopeKey).toBe(oldKey);
    expect(next.uiState.projectExpandedById[oldKey]).toBe(false);
    expect(next.uiState.projectExpandedById[newKey]).toBe(false);
  });

  it("does not overwrite an existing destination group's default merge method", () => {
    const previous = checkout("/repo/old");
    const project = checkout("/repo/new");
    const destination = checkout("/clone/new", {
      id: ProjectId.make("destination"),
      repositoryIdentity: { ...identity, rootPath: "/clone" },
    });
    const settings = grouping("repository_path");
    settings.pullRequestMergeMethodOverrides = {
      [deriveLogicalProjectKeyFromSettings(previous, settings)]: "rebase",
    };
    const next = relinkProjectPreferences(collapsed(previous, settings), {
      previous,
      project,
      projects: [project, destination],
      settings,
    });
    expect(next.settings.pullRequestMergeMethodOverrides).toEqual({});
  });

  it("keeps a destination's current ordering instead of duplicating its entry", () => {
    const previous = checkout("/old");
    const project = checkout("/new");
    const settings = grouping("separate");
    const oldKey = derivePhysicalProjectKey(previous);
    const newKey = derivePhysicalProjectKey(project);
    const state = { ...collapsed(previous, settings), projectOrder: [newKey, "other", oldKey] };
    expect(
      relinkProjectPreferences(state, { previous, project, projects: [project], settings }).uiState
        .projectOrder,
    ).toEqual([newKey, "other"]);
  });

  it("preserves an existing destination's merge method", () => {
    const previous = checkout("/old");
    const project = checkout("/new");
    const settings = grouping("separate");
    const oldKey = deriveLogicalProjectKeyFromSettings(previous, settings);
    const newKey = deriveLogicalProjectKeyFromSettings(project, settings);
    settings.pullRequestMergeMethodOverrides = { [oldKey]: "rebase", [newKey]: "squash" };
    const next = relinkProjectPreferences(collapsed(previous, settings), {
      previous,
      project,
      projects: [project],
      settings,
    });
    expect(next.settings.pullRequestMergeMethodOverrides).toEqual({ [newKey]: "squash" });
  });

  it("leaves a still-existing group's merge method in place", () => {
    const previous = checkout("/repo/old");
    const project = checkout("/repo/new");
    const sibling = checkout("/clone/old", {
      id: ProjectId.make("sibling"),
      repositoryIdentity: { ...identity, rootPath: "/clone" },
    });
    const settings = grouping("repository_path");
    const oldKey = deriveLogicalProjectKeyFromSettings(previous, settings);
    settings.pullRequestMergeMethodOverrides = { [oldKey]: "rebase" };
    const next = relinkProjectPreferences(collapsed(previous, settings), {
      previous,
      project,
      projects: [project, sibling],
      settings,
    });
    expect(next.settings.pullRequestMergeMethodOverrides).toBe(
      settings.pullRequestMergeMethodOverrides,
    );
  });

  it("does not restore a merge-method override removed while the relink was pending", () => {
    const previous = checkout("/old");
    const project = checkout("/new");
    const settings = grouping("separate");
    const next = relinkProjectPreferences(collapsed(previous, settings), {
      previous,
      project,
      projects: [project],
      settings,
    });
    expect(next.settings.pullRequestMergeMethodOverrides).toBe(
      settings.pullRequestMergeMethodOverrides,
    );
  });

  it.each([
    ["separate", identity],
    ["repository", null],
    ["repository_path", null],
    ["repository_path", identity],
  ] as const)("follows a vanished %s group with identity %j", (mode, repositoryIdentity) => {
    const settings = grouping(mode);
    const previous = checkout("/repo/old", { repositoryIdentity });
    const project = checkout("/repo/new", { repositoryIdentity });
    const next = relinkProjectUiState(collapsed(previous, settings), {
      previous,
      project,
      projects: [project],
      settings,
    });
    const key = deriveLogicalProjectKeyFromSettings(project, settings);
    expect(next.sidebarProjectScopeKey).toBe(key);
    expect(next.projectExpandedById[key]).toBe(false);
    expect(next.projectOrder).toEqual([derivePhysicalProjectKey(project)]);
  });

  it("uses the server's new repository root and preserves a stable logical scope", () => {
    const settings = grouping("repository_path");
    const previous = checkout("/repo/src");
    const project = checkout("/moved/src", {
      repositoryIdentity: { ...identity, rootPath: "/moved" },
    });
    const state = collapsed(previous, settings);
    const next = relinkProjectUiState(state, { previous, project, projects: [project], settings });
    expect(next.sidebarProjectScopeKey).toBe("github.com/example/repo::src");
    expect(next.projectExpandedById).toEqual(state.projectExpandedById);
    expect(next.projectOrder).toEqual(["environment:/moved/src"]);
  });

  it("keeps the old group's scope and expansion when another checkout remains", () => {
    const settings = grouping("repository_path");
    const previous = checkout("/repo/old");
    const project = checkout("/repo/new");
    const sibling = checkout("/clone/old", {
      id: ProjectId.make("sibling"),
      repositoryIdentity: { ...identity, rootPath: "/clone" },
    });
    const state = collapsed(previous, settings);
    const next = relinkProjectUiState(state, {
      previous,
      project,
      projects: [project, sibling],
      settings,
    });
    expect(next.sidebarProjectScopeKey).toBe(state.sidebarProjectScopeKey);
    expect(next.projectExpandedById[state.sidebarProjectScopeKey!]).toBe(false);
  });

  it("does not change a newly selected scope or an existing destination group's expansion", () => {
    const settings = grouping("repository_path");
    const previous = checkout("/repo/old");
    const project = checkout("/repo/new");
    const destination = checkout("/clone/new", {
      id: ProjectId.make("destination"),
      repositoryIdentity: { ...identity, rootPath: "/clone" },
    });
    const key = deriveLogicalProjectKeyFromSettings(project, settings);
    const state = {
      ...collapsed(previous, settings),
      sidebarProjectScopeKey: "another-user-selection",
      projectExpandedById: { [key]: true },
    };
    const next = relinkProjectUiState(state, {
      previous,
      project,
      projects: [project, destination],
      settings,
    });
    expect(next.sidebarProjectScopeKey).toBe("another-user-selection");
    expect(next.projectExpandedById).toEqual(state.projectExpandedById);
  });

  it("keeps an existing destination's default expansion without adding an override", () => {
    const settings = grouping("repository_path");
    const previous = checkout("/repo/old");
    const project = checkout("/repo/new");
    const destination = checkout("/clone/new", {
      id: ProjectId.make("destination"),
      repositoryIdentity: { ...identity, rootPath: "/clone" },
    });
    const state = collapsed(previous, settings);
    const next = relinkProjectUiState(state, {
      previous,
      project,
      projects: [project, destination],
      settings,
    });
    expect(next.projectExpandedById).toEqual(state.projectExpandedById);
  });

  it("keeps an explicit physical preference at the new path", () => {
    const settings = grouping("repository_path");
    const previous = checkout("/repo/old");
    const project = checkout("/repo/new");
    const state = collapsed(previous, settings);
    state.projectExpandedById[derivePhysicalProjectKey(project)] = true;
    const next = relinkProjectUiState(state, { previous, project, projects: [project], settings });
    expect(next.projectExpandedById).toEqual(state.projectExpandedById);
  });

  it.each([
    derivePhysicalProjectKey,
    (project: EnvironmentProject) => legacyProjectCwdPreferenceKey(project.workspaceRoot),
  ])("retains historical expansion fallbacks", (keyFor) => {
    const settings = grouping("repository");
    const previous = checkout("/old");
    const project = checkout("/new");
    const state = {
      ...collapsed(previous, settings),
      projectExpandedById: { [keyFor(previous)]: false },
    };
    const next = relinkProjectUiState(state, { previous, project, projects: [project], settings });
    expect(next.projectExpandedById[identity.canonicalKey]).toBe(false);
  });

  it("uses current grouping overrides and the authoritative path, including a normalized no-op", () => {
    const previous = checkout("/old");
    const project = checkout("/normalized/new");
    const settings = {
      ...grouping("repository"),
      sidebarProjectGroupingOverrides: {
        "environment:/old": "separate" as const,
        other: "repository_path" as const,
      },
    };
    const nextSettings = relinkProjectGroupingSettings(settings, previous, project, [project]);
    expect(nextSettings.sidebarProjectGroupingOverrides).toEqual({
      "environment:/normalized/new": "separate",
      other: "repository_path",
    });
    const next = relinkProjectUiState(collapsed(previous, settings), {
      previous,
      project,
      projects: [project],
      settings,
    });
    expect(next.sidebarProjectScopeKey).toBe("environment:/normalized/new");
    expect(relinkProjectGroupingSettings(settings, previous, { ...previous }, [previous])).toBe(
      settings,
    );
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

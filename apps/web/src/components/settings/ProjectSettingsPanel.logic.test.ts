import { describe, expect, it } from "vite-plus/test";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
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
  relinkProjectUiState,
  resolveSettingsProjectGroup,
} from "./ProjectSettingsPanel.logic";

describe("checkout settings navigation", () => {
  const groups = [
    { projectKey: "original-group", memberProjects: [{ environmentId: "local", id: "remaining" }] },
    { projectKey: "moved-group", memberProjects: [{ environmentId: "remote", id: "moved" }] },
    { projectKey: "other-machine", memberProjects: [{ environmentId: "local", id: "moved" }] },
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
      { projectKey: "old-group", memberProjects: [{ environmentId: "a", id: "b:c" }] },
      { projectKey: "moved-group", memberProjects: [{ environmentId: "a:b", id: "c" }] },
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
      { projectKey: "first", memberProjects: [{ environmentId: "a", id: "b:c" }] },
      { projectKey: "intended", memberProjects: [{ environmentId: "a:b", id: "c" }] },
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
    const targetGroup = { projectKey: "target", memberProjects: [member] };
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

function grouping(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
): ProjectGroupingSettings {
  return { sidebarProjectGroupingMode: mode, sidebarProjectGroupingOverrides: {} };
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
    const nextSettings = relinkProjectGroupingSettings(settings, previous, project);
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
    expect(relinkProjectGroupingSettings(settings, previous, { ...previous })).toBe(settings);
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

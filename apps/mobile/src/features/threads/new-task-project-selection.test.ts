import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  newTaskDestination,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  resolveNewTaskEnvironmentProject,
  resolveNewTaskEnvironments,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/t3code",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("requires explicit identity for non-Git copies and respects separate mode", () => {
    const groupingIdentity = "39c61a1b-8a64-43a6-9da5-65c15da93d52";
    const selected = { ...makeProject("sdk", "mac"), groupingIdentity };
    const unrelated = makeProject("sdk", "server");
    const target = { ...makeProject("copy", "server"), groupingIdentity };
    expect(resolveEnvironmentProjectMatch([unrelated], selected)).toBeNull();
    expect(resolveEnvironmentProjectMatch([unrelated, target], selected)).toBe(target);
    expect(
      resolveEnvironmentProjectMatch([target], selected, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      }),
    ).toBeNull();
    expect(
      resolveEnvironmentProjectMatch([unrelated], { ...selected, groupingIdentity: null }),
    ).toBeNull();
  });
  it("does not switch to unrelated repositories or first-project fallbacks", () => {
    const selected = makeProject("sdk", "mac", { repositoryKey: "github.com/g/sdk" });
    expect(
      resolveEnvironmentProjectMatch(
        [makeProject("sdk", "server", { repositoryKey: "github.com/other/sdk" })],
        selected,
      ),
    ).toBeNull();
    expect(resolveEnvironmentProjectMatch([], selected)).toBeNull();
  });
});

describe("resolveNewTaskEnvironmentProject", () => {
  const settings = {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  };

  it("routes duplicate physical records using the same inherited Git identity as project grouping", () => {
    const older = makeProject("older", "mac", {
      workspaceRoot: "/sdk",
      repositoryKey: "github.com/g/sdk",
    });
    const selectedProject = {
      ...makeProject("newer", "mac", { workspaceRoot: "/sdk" }),
      groupingIdentity: "39c61a1b-8a64-43a6-9da5-65c15da93d52",
      updatedAt: "2026-07-02T00:00:00.000Z",
    };
    const remote = makeProject("copy", "server", { repositoryKey: "github.com/g/sdk" });
    const projects = [selectedProject, older, remote];
    expect(
      resolveNewTaskEnvironmentProject({
        environmentId: remote.environmentId,
        projects,
        selectedProject,
        pendingProject: null,
        settings,
      }),
    ).toBe(remote);
    expect(
      resolveNewTaskEnvironments({
        projects,
        selectedProject,
        settings,
        pendingTaskEnvironmentId: null,
        savedConnectionsById: {
          mac: { environmentLabel: "Mac" },
          server: { environmentLabel: "Server" },
        },
      }).map((environment) => environment.environmentId),
    ).toEqual(["mac", "server"]);
  });

  it("preserves the queued project's identity when its host has no loaded projects", () => {
    const pendingProject = makeProject("queued-project", "offline");
    const unrelated = makeProject("unrelated", "server");
    const input = {
      environmentId: pendingProject.environmentId,
      projects: [unrelated],
      selectedProject: pendingProject,
      pendingProject,
      settings,
    };
    expect(resolveNewTaskEnvironmentProject(input)).toBe(pendingProject);
    // Returning to the task's own host must also preserve its stamped project.
    expect(resolveNewTaskEnvironmentProject({ ...input, selectedProject: unrelated })).toBe(
      pendingProject,
    );
    expect(
      resolveNewTaskEnvironmentProject({ ...input, environmentId: unrelated.environmentId }),
    ).toBeNull();
  });

  it("switches within the explicit group without reusing the queued project on another host", () => {
    const groupingIdentity = "39c61a1b-8a64-43a6-9da5-65c15da93d52";
    const pendingProject = { ...makeProject("sdk", "mac"), groupingIdentity };
    const copy = { ...makeProject("sdk-copy", "server"), groupingIdentity };
    const input = {
      environmentId: copy.environmentId,
      projects: [pendingProject, copy],
      selectedProject: pendingProject,
      pendingProject,
      settings,
    };
    expect(resolveNewTaskEnvironmentProject(input)).toBe(copy);
    expect(resolveNewTaskEnvironmentProject({ ...input, projects: [] })).toBeNull();
    expect(
      resolveNewTaskEnvironmentProject({
        ...input,
        settings: { ...settings, sidebarProjectGroupingMode: "separate" },
      }),
    ).toBeNull();
  });
});

describe("resolveNewTaskEnvironments", () => {
  const settings = {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  };
  const savedConnectionsById = {
    mac: { environmentLabel: "Mac" },
    server: { environmentLabel: "Server" },
  };

  it("retains the queued task's machine and label while its project shell is absent", () => {
    const missingProject = makeProject("removed", "mac");
    expect(
      resolveNewTaskEnvironments({
        projects: [makeProject("unrelated", "mac"), makeProject("other", "server")],
        selectedProject: missingProject,
        settings,
        savedConnectionsById,
        pendingTaskEnvironmentId: missingProject.environmentId,
      }),
    ).toEqual([{ environmentId: "mac", environmentLabel: "Mac" }]);
  });

  it("lists only registered hosts of the explicit group and deduplicates the task's host", () => {
    const groupingIdentity = "39c61a1b-8a64-43a6-9da5-65c15da93d52";
    const selectedProject = { ...makeProject("sdk", "mac"), groupingIdentity };
    const input = {
      projects: [
        selectedProject,
        { ...makeProject("copy", "server"), groupingIdentity },
        { ...makeProject("copy", "unsaved"), groupingIdentity },
      ],
      selectedProject,
      settings,
      savedConnectionsById,
      pendingTaskEnvironmentId: selectedProject.environmentId,
    };
    expect(resolveNewTaskEnvironments(input)).toEqual([
      { environmentId: "mac", environmentLabel: "Mac" },
      { environmentId: "server", environmentLabel: "Server" },
    ]);
    expect(
      resolveNewTaskEnvironments({
        ...input,
        settings: { ...settings, sidebarProjectGroupingMode: "separate" },
      }),
    ).toEqual([{ environmentId: "mac", environmentLabel: "Mac" }]);
  });

  it("does not offer unrelated machines for an ordinary draft with a missing project", () => {
    expect(
      resolveNewTaskEnvironments({
        projects: [makeProject("other", "server")],
        selectedProject: makeProject("missing", "mac"),
        settings,
        savedConnectionsById,
        pendingTaskEnvironmentId: null,
      }),
    ).toEqual([]);
  });
});

describe("resolveDraftProjectSelection", () => {
  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("newTaskDestination", () => {
  it("opens the current thread's project directly in split view", () => {
    const projects = [makeProject("first"), makeProject("current", "other-environment")];
    expect(newTaskDestination(true, projects, projects[1], "request")).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });
  it("uses an available project when split view has no current project", () => {
    expect(newTaskDestination(true, [makeProject("first")], undefined, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "first" },
    });
  });
  it("keeps the picker when there are no projects", () => {
    expect(newTaskDestination(true, [], undefined, "request")).toEqual({
      draft: { requestId: "request" },
    });
  });
  it("opens the same draft route in compact view", () => {
    const project = makeProject("current");
    expect(newTaskDestination(false, [project], project, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });
});

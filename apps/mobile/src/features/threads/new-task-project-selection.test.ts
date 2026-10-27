import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  newTaskDestination,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
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

describe("getProjectScopeSelectionTarget", () => {
  it("prefers a connected copy of a project that spans environments", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const target = (connected: ReadonlyArray<string>, preferred: string | null = null) =>
      getProjectScopeSelectionTarget(
        makeScope([mac, server]),
        preferred === null ? null : EnvironmentId.make(preferred),
        new Set(connected.map((id) => EnvironmentId.make(id))),
      );
    expect(target(["server"])).toBe(server);
    expect(target(["server"], "mac")).toBe(server);
    expect(target(["mac", "server"], "server")).toBe(server);
    expect(target(["mac", "server"])).toBe(mac);
    // With nothing connected, the usual order still applies.
    expect(target([], "server")).toBe(server);
    expect(target([])).toBe(mac);
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("resolveDraftProjectSelection", () => {
  const projects = [makeProject("t3code"), makeProject("t3code-2")];
  const draft = { incomingShareId: undefined, pickerClosed: false };

  it("opens the picker instead of auto-selecting the only project", () => {
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)], draft)).toEqual({
      kind: "pick",
    });
  });

  it("selects the only logical project for shared content", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        incomingShareId: "share",
      }),
    ).toEqual({ kind: "select", project: projects[0] });
  });

  it("dismisses the draft when the first picker closes without a choice", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("keeps the draft when the picker closes after a choice", () => {
    expect(
      resolveDraftProjectSelection("environment:t3code-2", projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "preserve" });
  });

  it("keeps a share draft asking for a project when its picker closes without a choice", () => {
    const scopes = [makeScope([projects[0]!]), makeScope([projects[1]!])];
    expect(
      resolveDraftProjectSelection(null, projects, scopes, {
        incomingShareId: "share",
        pickerClosed: true,
      }),
    ).toEqual({ kind: "pick" });
  });
});

describe("newTaskDestination", () => {
  const picker = { draft: { requestId: "request" } };

  function destination(options: {
    readonly useLastProject: boolean | undefined;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly current?: EnvironmentProject;
    readonly last?: { readonly environmentId: string; readonly projectId: string };
  }) {
    return newTaskDestination({
      projects: options.projects,
      requestId: "request",
      useLastProject: options.useLastProject,
      currentProject: options.current && {
        environmentId: options.current.environmentId,
        projectId: options.current.id,
      },
      lastProject: options.last,
    });
  }

  it("starts in the current thread's project ahead of the remembered one", () => {
    const projects = [makeProject("remembered"), makeProject("current", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        current: projects[1],
        last: { environmentId: "environment", projectId: "remembered" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });

  it("treats an unset preference as on", () => {
    const projects = [makeProject("first"), makeProject("current")];
    expect(destination({ useLastProject: undefined, projects, current: projects[1] })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });

  it("starts in the remembered project of its own environment when there is no current one", () => {
    const projects = [makeProject("chosen"), makeProject("chosen", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        last: { environmentId: "other-environment", projectId: "chosen" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "chosen" },
    });
  });

  it("ignores a remembered project id from another environment", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("chosen")],
        last: { environmentId: "removed-environment", projectId: "chosen" },
      }),
    ).toEqual(picker);
  });

  it("opens the picker rather than the first project when nothing matches", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("first"), makeProject("second")],
        current: makeProject("removed"),
      }),
    ).toEqual(picker);
  });

  it("always opens the picker when the preference is off", () => {
    const only = makeProject("only");
    expect(
      destination({
        useLastProject: false,
        projects: [only],
        current: only,
        last: { environmentId: "environment", projectId: "only" },
      }),
    ).toEqual(picker);
  });
});

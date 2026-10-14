import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveAutoBalanceStatus,
  resolveBalancedProjects,
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
  it("keeps the current environment when it hosts the selected logical project", () => {
    const projects = [makeProject("t3code-mac", "mac"), makeProject("t3code-server", "server")];
    expect(getProjectScopeSelectionTarget(makeScope(projects), EnvironmentId.make("server"))).toBe(
      projects[1],
    );
  });

  it("falls back to the representative when the current environment does not host the project", () => {
    const projects = [makeProject("t3code-mac", "mac"), makeProject("t3code-server", "server")];
    expect(getProjectScopeSelectionTarget(makeScope(projects), EnvironmentId.make("other"))).toBe(
      projects[0],
    );
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

  it("falls back to the first project on the target so the draft has a key to carry over to", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [makeProject("unrelated", "server"), makeProject("also-unrelated", "server")];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[0]);
    expect(resolveEnvironmentProjectMatch([], selected)).toBeNull();
  });
});

describe("resolveDraftProjectSelection", () => {
  it("preserves an explicit project selection", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:t3code", [project], [makeScope([project])]),
    ).toEqual({ kind: "preserve" });
  });

  it("selects the only physical project when no project was explicitly selected", () => {
    const project = makeProject("t3code");
    expect(resolveDraftProjectSelection(null, [project], [makeScope([project])])).toEqual({
      kind: "select",
      project,
    });
  });

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

describe("filterProjectScopes", () => {
  const mac = makeProject("code", "mac", { title: "Desktop checkout" });
  const server = makeProject("remote-code", "server", { workspaceRoot: "/srv/remote-workspace" });
  const code = makeScope([mac, server]);
  const docs = { ...makeScope([makeProject("docs")]), key: "docs", title: "Documentation" };
  const scopes = [code, docs];

  it("keeps all projects for an empty or whitespace-only query", () => {
    expect(filterProjectScopes(scopes, "")).toBe(scopes);
    expect(filterProjectScopes(scopes, "  ")).toBe(scopes);
  });

  it("matches logical names and workspace names or paths without case sensitivity", () => {
    expect(filterProjectScopes(scopes, "  T3 CODE ")).toEqual([code]);
    expect(filterProjectScopes(scopes, "DESKTOP")).toEqual([code]);
    expect(filterProjectScopes(scopes, "REMOTE-WORKSPACE")).toEqual([code]);
    expect(filterProjectScopes(scopes, "documentation")).toEqual([docs]);
    expect(filterProjectScopes(scopes, "missing-project")).toEqual([]);
  });

  it("preserves the whole logical project and preferred environment when a workspace matches", () => {
    const matches = filterProjectScopes(scopes, "REMOTE-WORKSPACE");
    expect(matches[0]).toBe(code);
    expect(getProjectScopeSelectionTarget(matches[0]!, EnvironmentId.make("mac"))).toBe(mac);
    expect(code.projects).toEqual([mac, server]);
  });
});

describe("resolveAutoBalanceStatus", () => {
  const automatic = {
    canAutoBalance: true,
    environmentPinned: false,
    hasAttachments: false,
    loadBalancedEnvironmentId: null,
    pending: false,
  };
  const mac = EnvironmentId.make("mac");

  it("reports the routing progress of an automatic draft", () => {
    expect(resolveAutoBalanceStatus({ ...automatic, pending: true })).toBe("checking");
    expect(resolveAutoBalanceStatus(automatic)).toBe("unavailable");
    expect(resolveAutoBalanceStatus({ ...automatic, loadBalancedEnvironmentId: mac })).toBe(
      "balanced",
    );
  });

  it("leaves a pinned or ineligible draft on its machine", () => {
    expect(resolveAutoBalanceStatus({ ...automatic, environmentPinned: true })).toBeNull();
    expect(resolveAutoBalanceStatus({ ...automatic, canAutoBalance: false })).toBeNull();
  });

  it("keeps attachments in place unless the draft was already routed", () => {
    expect(resolveAutoBalanceStatus({ ...automatic, hasAttachments: true })).toBeNull();
    expect(
      resolveAutoBalanceStatus({
        ...automatic,
        hasAttachments: true,
        loadBalancedEnvironmentId: mac,
      }),
    ).toBe("balanced");
  });
});

describe("resolveBalancedProjects", () => {
  const webOnA = makeProject("a-web", "a", { repositoryKey: "repo" });
  const apiOnB = makeProject("b-api", "b", { repositoryKey: "repo" });
  const webOnB = makeProject("b-web", "b", { repositoryKey: "repo" });

  it("routes only within the selected project's own group", () => {
    // Grouped by repository path: the API project shares the repository but
    // is a different project, even though it is listed first on its machine.
    const scopes = [
      { ...makeScope([apiOnB]), key: "repo:apps/api" },
      { ...makeScope([webOnA, webOnB]), key: "repo:apps/web" },
    ];
    expect(resolveBalancedProjects(scopes, webOnA)).toEqual([webOnA, webOnB]);
  });

  it("offers one copy per machine, keeping the selected one", () => {
    const secondOnA = makeProject("a-web-2", "a", { repositoryKey: "repo" });
    const scopes = [makeScope([webOnA, secondOnA, webOnB])];
    expect(resolveBalancedProjects(scopes, secondOnA)).toEqual([secondOnA, webOnB]);
  });

  it("has nothing to balance for an ungrouped or missing project", () => {
    expect(resolveBalancedProjects([makeScope([webOnA])], webOnA)).toEqual([webOnA]);
    expect(resolveBalancedProjects([makeScope([webOnB])], webOnA)).toEqual([]);
    expect(resolveBalancedProjects([makeScope([webOnA])], null)).toEqual([]);
  });
});

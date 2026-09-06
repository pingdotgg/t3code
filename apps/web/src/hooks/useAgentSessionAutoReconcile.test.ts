import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { selectUnreconciledProjects } from "./useAgentSessionAutoReconcile";

function makeProject(
  environmentId: string,
  projectId: string,
  workspaceRoot = `/home/user/${projectId}`,
): EnvironmentProject {
  return {
    environmentId: environmentId as EnvironmentId,
    id: projectId as ProjectId,
    title: projectId,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as EnvironmentProject;
}

describe("selectUnreconciledProjects", () => {
  it("returns all projects when none have been reconciled", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a"), makeProject("env-1", "proj-b")];
    const result = selectUnreconciledProjects(projects, reconciled);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("proj-a");
    expect(result[1]!.id).toBe("proj-b");
  });

  it("marks returned projects as reconciled", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a")];
    selectUnreconciledProjects(projects, reconciled);
    expect(reconciled.has("env-1\0proj-a")).toBe(true);
  });

  it("skips already-reconciled projects on subsequent calls", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a"), makeProject("env-1", "proj-b")];
    selectUnreconciledProjects(projects, reconciled);
    const result = selectUnreconciledProjects(projects, reconciled);
    expect(result).toHaveLength(0);
  });

  it("returns only newly added projects", () => {
    const reconciled = new Set<string>();
    const initial = [makeProject("env-1", "proj-a")];
    selectUnreconciledProjects(initial, reconciled);

    const withNew = [...initial, makeProject("env-1", "proj-b")];
    const result = selectUnreconciledProjects(withNew, reconciled);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("proj-b");
  });

  it("returns empty array when projects list is empty", () => {
    const reconciled = new Set<string>();
    const result = selectUnreconciledProjects([], reconciled);
    expect(result).toHaveLength(0);
  });

  it("distinguishes projects with the same id across different environments", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a"), makeProject("env-2", "proj-a")];
    const result = selectUnreconciledProjects(projects, reconciled);
    expect(result).toHaveLength(2);

    const second = selectUnreconciledProjects(projects, reconciled);
    expect(second).toHaveLength(0);
  });

  it("handles a project removed then re-added (stays reconciled)", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a"), makeProject("env-1", "proj-b")];
    selectUnreconciledProjects(projects, reconciled);

    const removed = [makeProject("env-1", "proj-b")];
    const afterRemove = selectUnreconciledProjects(removed, reconciled);
    expect(afterRemove).toHaveLength(0);

    const reAdded = [makeProject("env-1", "proj-a"), makeProject("env-1", "proj-b")];
    const afterReAdd = selectUnreconciledProjects(reAdded, reconciled);
    expect(afterReAdd).toHaveLength(0);
  });
});

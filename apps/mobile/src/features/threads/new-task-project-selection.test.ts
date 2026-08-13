import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  getOnlySelectableProject,
  resolveDraftProjectSelection,
} from "./new-task-project-selection";

function makeProject(id: string): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make("environment"),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
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

describe("getOnlySelectableProject", () => {
  it("auto-selects when there is exactly one physical project", () => {
    const project = makeProject("t3code");
    expect(getOnlySelectableProject([makeScope([project])])).toBe(project);
  });

  it("does not auto-select a representative when one group has multiple clones", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(getOnlySelectableProject([makeScope(projects)])).toBeNull();
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

  it("opens the picker for multiple physical projects in one logical group", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "pick",
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

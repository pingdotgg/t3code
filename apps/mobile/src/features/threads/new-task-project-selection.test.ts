import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import { getOnlySelectableProject } from "./new-task-project-selection";

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

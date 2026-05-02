import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildProjectFolderSearchResults } from "./projectFolderSearch";
import type { Project } from "../types";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function makeProject(id: string, name: string, cwd: string): Project {
  return {
    id: id as ProjectId,
    environmentId: ENVIRONMENT_ID,
    name,
    cwd,
    defaultModelSelection: null,
    scripts: [],
  };
}

describe("buildProjectFolderSearchResults", () => {
  it("prefers direct name matches over cwd-only matches", () => {
    const results = buildProjectFolderSearchResults({
      query: "server",
      projects: [
        makeProject("project-1", "Clay Server", "/repo/server"),
        makeProject("project-2", "Marketing", "/repo/server-tools"),
      ],
    });

    expect(results.results.map((result) => result.project.id)).toEqual(["project-1", "project-2"]);
  });

  it("includes all projects when the query is empty", () => {
    const results = buildProjectFolderSearchResults({
      query: "",
      projects: [
        makeProject("project-1", "Server", "/repo/server"),
        makeProject("project-2", "Desktop", "/repo/desktop"),
      ],
    });

    expect(results.totalResults).toBe(2);
    expect(results.results).toHaveLength(2);
  });
});

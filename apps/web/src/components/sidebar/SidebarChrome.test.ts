import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestsSearchForProject } from "./SidebarChrome";

describe("sidebar pull request navigation", () => {
  it("scopes pull requests to the selected project and its environment", () => {
    expect(
      pullRequestsSearchForProject({
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
      }),
    ).toEqual({
      involvement: "all",
      state: "open",
      environmentId: "environment-1",
      projectId: "project-1",
    });
  });

  it("keeps the pull request list unscoped when all projects are selected", () => {
    expect(pullRequestsSearchForProject(null)).toEqual({
      involvement: "all",
      state: "open",
    });
  });
});

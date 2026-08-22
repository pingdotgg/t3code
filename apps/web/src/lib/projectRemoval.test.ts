import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasArchivedThreadSnapshotFailure,
  projectDeleteCommandInput,
  projectThreadCount,
} from "./projectRemoval";

describe("hasArchivedThreadSnapshotFailure", () => {
  it("only reports failures for environments being removed", () => {
    const environmentOne = EnvironmentId.make("environment-1");
    const environmentTwo = EnvironmentId.make("environment-2");
    const failedEnvironmentIds = [environmentTwo];

    expect([
      hasArchivedThreadSnapshotFailure([{ environmentId: environmentOne }], failedEnvironmentIds),
      hasArchivedThreadSnapshotFailure([{ environmentId: environmentTwo }], failedEnvironmentIds),
    ]).toEqual([false, true]);
  });
});

describe("projectDeleteCommandInput", () => {
  it("force-deletes threads even when only archived threads exist", () => {
    const project = {
      environmentId: EnvironmentId.make("environment-1"),
      id: ProjectId.make("project-1"),
    };
    const archivedThreads = [
      {
        environmentId: project.environmentId,
        projectId: project.id,
      },
    ];

    expect(
      projectDeleteCommandInput(project.id, projectThreadCount(project, archivedThreads)),
    ).toEqual({
      projectId: "project-1",
      force: true,
    });
  });

  it("does not force an empty project when the same project id has threads in another environment", () => {
    const projectId = ProjectId.make("shared-project-id");
    const environmentOneProject = {
      environmentId: EnvironmentId.make("environment-1"),
      id: projectId,
    };
    const environmentTwoProject = {
      environmentId: EnvironmentId.make("environment-2"),
      id: projectId,
    };
    const threads = [
      {
        environmentId: environmentTwoProject.environmentId,
        projectId,
      },
    ];

    expect(
      projectDeleteCommandInput(projectId, projectThreadCount(environmentOneProject, threads)),
    ).toEqual({ projectId });
    expect(
      projectDeleteCommandInput(projectId, projectThreadCount(environmentTwoProject, threads)),
    ).toEqual({ projectId, force: true });
  });
});

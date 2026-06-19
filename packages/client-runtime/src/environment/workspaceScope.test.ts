import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  filterProjectsForVscodeScope,
  resolveVscodeInitialThreadRef,
  resolveVscodeProjectScope,
} from "./workspaceScope.ts";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("resolveVscodeProjectScope", () => {
  it("prefers multi-root bootstrap projects from the server welcome payload", () => {
    expect(
      resolveVscodeProjectScope({
        serverConfig: {
          environment: { environmentId: localEnvironmentId },
          cwd: "/workspace/active",
        },
        serverWelcome: {
          environment: { environmentId: localEnvironmentId },
          bootstrapProjects: [
            {
              projectId: ProjectId.make("project-active"),
              cwd: "/workspace/active",
              isActive: true,
            },
            { projectId: ProjectId.make("project-other"), cwd: "/workspace/other" },
          ],
        },
      }),
    ).toMatchObject({
      environmentId: localEnvironmentId,
      projectIds: [ProjectId.make("project-active"), ProjectId.make("project-other")],
      activeProjectId: ProjectId.make("project-active"),
      cwd: "/workspace/active",
      cwds: ["/workspace/active", "/workspace/other"],
    });
  });
});

describe("filterProjectsForVscodeScope", () => {
  it("keeps only projects inside the resolved VS Code environment and project scope", () => {
    const currentProject = {
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-current"),
      workspaceRoot: "/workspace/current",
    };
    const siblingProject = {
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-sibling"),
      workspaceRoot: "/workspace/sibling",
    };
    const remoteProject = {
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-current"),
      workspaceRoot: "/workspace/current",
    };

    expect(
      filterProjectsForVscodeScope([siblingProject, remoteProject, currentProject], {
        environmentId: localEnvironmentId,
        projectId: ProjectId.make("project-current"),
      }),
    ).toEqual([currentProject]);
  });
});

describe("resolveVscodeInitialThreadRef", () => {
  it("prefers the active VS Code project before last-visited recency", () => {
    const activeOlder = {
      id: ThreadId.make("thread-active-older"),
      environmentId: localEnvironmentId,
      projectId: ProjectId.make("project-active"),
      archivedAt: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    };
    const inactiveNewer = {
      id: ThreadId.make("thread-inactive-newer"),
      environmentId: localEnvironmentId,
      projectId: ProjectId.make("project-inactive"),
      archivedAt: null,
      updatedAt: "2026-03-09T12:00:00.000Z",
    };

    expect(
      resolveVscodeInitialThreadRef({
        threads: [inactiveNewer, activeOlder],
        threadLastVisitedAtById: {
          [`${localEnvironmentId}:${inactiveNewer.id}`]: "2026-03-09T13:00:00.000Z",
        },
        scope: {
          environmentId: localEnvironmentId,
          projectIds: [ProjectId.make("project-active"), ProjectId.make("project-inactive")],
          activeProjectId: ProjectId.make("project-active"),
        },
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      threadId: activeOlder.id,
    });
  });
});

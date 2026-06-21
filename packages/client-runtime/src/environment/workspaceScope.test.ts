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

  it("keeps same-root projects when VS Code bootstrap project ids differ from existing history", () => {
    const historicalProject = {
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-historical"),
      workspaceRoot: "/workspace/current/",
    };
    const bootstrappedProject = {
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-bootstrapped"),
      workspaceRoot: "/workspace/current",
    };
    const siblingProject = {
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-sibling"),
      workspaceRoot: "/workspace/sibling",
    };

    expect(
      filterProjectsForVscodeScope([historicalProject, siblingProject, bootstrappedProject], {
        environmentId: localEnvironmentId,
        projectIds: [ProjectId.make("project-bootstrapped")],
        cwds: ["/workspace/current"],
      }),
    ).toEqual([historicalProject, bootstrappedProject]);
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

  it("uses shared latest-user-message recency when last-visited state is tied", () => {
    const olderUpdatedNewerPrompt = {
      id: ThreadId.make("thread-older-updated-newer-prompt"),
      environmentId: localEnvironmentId,
      projectId: ProjectId.make("project-active"),
      archivedAt: null,
      updatedAt: "2026-03-09T12:00:00.000Z",
      latestUserMessageAt: "2026-03-09T10:00:00.000Z",
    };
    const newerUserPrompt = {
      id: ThreadId.make("thread-newer-prompt"),
      environmentId: localEnvironmentId,
      projectId: ProjectId.make("project-active"),
      archivedAt: null,
      updatedAt: "2026-03-09T11:00:00.000Z",
      messages: [
        { role: "assistant", createdAt: "2026-03-09T12:30:00.000Z" },
        { role: "user", createdAt: "2026-03-09T11:30:00.000Z" },
      ],
    };

    expect(
      resolveVscodeInitialThreadRef({
        threads: [olderUpdatedNewerPrompt, newerUserPrompt],
        threadLastVisitedAtById: {},
        scope: {
          environmentId: localEnvironmentId,
          projectId: ProjectId.make("project-active"),
        },
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      threadId: newerUserPrompt.id,
    });
  });
});

import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@forma/contracts";
import {
  getNoActiveThreadProjectItems,
  getNoActiveThreadRecentThreadItems,
  resolveNoActiveThreadStateVariant,
} from "./NoActiveThreadState.logic";
import { getProjectOrderKey } from "../logicalProject";
import { DEFAULT_INTERACTION_MODE, type Project, type SidebarThreadSummary } from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make(`project-${overrides.name ?? "one"}`),
    environmentId: localEnvironmentId,
    name: "Project",
    cwd: "/repo/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(`thread-${overrides.title ?? "one"}`),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-one"),
    title: "Thread",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    queuedTurnCount: 0,
    turnQueueStatus: "idle",
    ...overrides,
  };
}

describe("resolveNoActiveThreadStateVariant", () => {
  it("returns no-projects when there are no projects", () => {
    expect(
      resolveNoActiveThreadStateVariant({
        projects: [],
        threads: [],
      }),
    ).toBe("no-projects");
  });

  it("returns projects-no-threads when projects exist without visible threads", () => {
    expect(
      resolveNoActiveThreadStateVariant({
        projects: [makeProject()],
        threads: [makeThread({ archivedAt: "2026-04-01T01:00:00.000Z" })],
      }),
    ).toBe("projects-no-threads");
  });

  it("returns recent-threads when at least one visible thread exists", () => {
    expect(
      resolveNoActiveThreadStateVariant({
        projects: [makeProject()],
        threads: [makeThread()],
      }),
    ).toBe("recent-threads");
  });
});

describe("getNoActiveThreadProjectItems", () => {
  it("honors manual project ordering via projectOrder physical keys", () => {
    const alpha = makeProject({
      id: ProjectId.make("project-alpha"),
      name: "Alpha",
      cwd: "/repo/alpha",
    });
    const beta = makeProject({
      id: ProjectId.make("project-beta"),
      name: "Beta",
      cwd: "/repo/beta",
    });
    const gamma = makeProject({
      id: ProjectId.make("project-gamma"),
      name: "Gamma",
      cwd: "/repo/gamma",
    });

    const items = getNoActiveThreadProjectItems({
      projects: [alpha, beta, gamma],
      threads: [
        makeThread({
          id: ThreadId.make("thread-beta"),
          projectId: beta.id,
          title: "Beta thread",
          latestUserMessageAt: "2026-04-01T03:00:00.000Z",
        }),
      ],
      projectOrder: [getProjectOrderKey(gamma), getProjectOrderKey(alpha)],
      projectSortOrder: "manual",
      threadSortOrder: "updated_at",
    });

    expect(items.map((item) => item.project.name)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(items[2]?.latestThread?.title).toBe("Beta thread");
  });
});

describe("getNoActiveThreadRecentThreadItems", () => {
  it("sorts visible threads by the configured order and limits to six items", () => {
    const threads = Array.from({ length: 7 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
        projectId: ProjectId.make(`project-${index + 1}`),
        latestUserMessageAt: `2026-04-01T0${7 - index}:00:00.000Z`,
      }),
    );
    const projects = threads.map((thread, index) =>
      makeProject({
        id: thread.projectId,
        name: `Project ${index + 1}`,
        cwd: `/repo/project-${index + 1}`,
      }),
    );

    const items = getNoActiveThreadRecentThreadItems({
      projects,
      threads,
      sortOrder: "updated_at",
    });

    expect(items).toHaveLength(6);
    expect(items.map((item) => item.thread.title)).toEqual([
      "Thread 1",
      "Thread 2",
      "Thread 3",
      "Thread 4",
      "Thread 5",
      "Thread 6",
    ]);
    expect(items[0]?.project?.name).toBe("Project 1");
  });

  it("resolves recent-thread project context by environment and project id", () => {
    const sharedProjectId = ProjectId.make("project-shared");
    const localProject = makeProject({
      id: sharedProjectId,
      name: "Local project",
      cwd: "/repo/local",
    });
    const remoteProject = makeProject({
      id: sharedProjectId,
      environmentId: remoteEnvironmentId,
      name: "Remote project",
      cwd: "/repo/remote",
    });
    const remoteThread = makeThread({
      id: ThreadId.make("thread-remote"),
      environmentId: remoteEnvironmentId,
      projectId: sharedProjectId,
      title: "Remote thread",
      latestUserMessageAt: "2026-04-01T08:00:00.000Z",
    });

    const items = getNoActiveThreadRecentThreadItems({
      projects: [localProject, remoteProject],
      threads: [remoteThread],
      sortOrder: "updated_at",
    });

    expect(items[0]?.project?.name).toBe("Remote project");
    expect(items[0]?.project?.cwd).toBe("/repo/remote");
  });
});

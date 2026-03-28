import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { resolveProjectRouteTarget } from "./projectRoute";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project, type Thread } from "./types";

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Repo",
    cwd: "/repo",
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
    ...overrides,
  };
}

function makeThread(overrides?: Partial<Thread>): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("resolveProjectRouteTarget", () => {
  it("returns missing when the project does not exist", () => {
    expect(
      resolveProjectRouteTarget({
        projectId: ProjectId.makeUnsafe("missing-project"),
        projects: [],
        threads: [],
        threadSortOrder: "updated_at",
      }),
    ).toEqual({ kind: "missing" });
  });

  it("returns empty when the project has no threads", () => {
    expect(
      resolveProjectRouteTarget({
        projectId: ProjectId.makeUnsafe("project-1"),
        projects: [makeProject()],
        threads: [],
        threadSortOrder: "updated_at",
      }),
    ).toEqual({
      kind: "empty",
      project: makeProject(),
    });
  });

  it("returns the latest thread for the project", () => {
    expect(
      resolveProjectRouteTarget({
        projectId: ProjectId.makeUnsafe("project-1"),
        projects: [makeProject()],
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("thread-older"),
            updatedAt: "2026-03-28T09:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.makeUnsafe("thread-newer"),
            updatedAt: "2026-03-28T11:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.makeUnsafe("thread-other-project"),
            projectId: ProjectId.makeUnsafe("project-2"),
            updatedAt: "2026-03-28T12:00:00.000Z",
          }),
        ],
        threadSortOrder: "updated_at",
      }),
    ).toEqual({
      kind: "thread",
      project: makeProject(),
      threadId: ThreadId.makeUnsafe("thread-newer"),
    });
  });
});

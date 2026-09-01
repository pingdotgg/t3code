import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBoardCards, groupBoardCardsByProject } from "./board.logic";

type BoardThread = Parameters<typeof buildBoardCards>[0]["threads"][number];
type BoardProject = Parameters<typeof buildBoardCards>[0]["projects"][number];

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("local");

function thread(overrides: Partial<BoardThread> = {}): BoardThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "Fix the board",
    updatedAt: "2026-08-31T11:00:00.000Z",
    ...overrides,
  };
}

function project(overrides: Partial<BoardProject> = {}): BoardProject {
  return {
    id: ProjectId.make("project-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "T3 Code",
    workspaceRoot: "/work/t3code",
    faviconPath: null,
    ...overrides,
  };
}

describe("board logic", () => {
  it("keeps the newest active thread first", () => {
    const cards = buildBoardCards({
      projects: [project()],
      threads: [
        thread(),
        thread({ id: ThreadId.make("newest"), updatedAt: "2026-08-31T11:30:00.000Z" }),
      ],
    });

    expect(cards.map((card) => card.thread.id)).toEqual(["newest", "thread-1"]);
  });

  it("keeps project and environment identity on each card and groups cards by project", () => {
    const cards = buildBoardCards({
      projects: [project(), project({ id: ProjectId.make("project-2"), title: "Docs" })],
      environmentLabels: new Map([[LOCAL_ENVIRONMENT_ID, "Laptop"]]),
      threads: [
        thread({
          id: ThreadId.make("docs"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-08-31T11:30:00.000Z",
        }),
        thread({ id: ThreadId.make("code-2"), updatedAt: "2026-08-31T11:15:00.000Z" }),
      ],
    });

    expect(cards[0]).toMatchObject({
      projectKey: '["local","project-2"]',
      projectTitle: "Docs",
      environmentLabel: "Laptop",
    });
    expect(groupBoardCardsByProject(cards).map((section) => section.projectTitle)).toEqual([
      "Docs",
      "T3 Code",
    ]);
  });

  it("keeps scoped project identities distinct when ids contain separators", () => {
    const environmentAB = EnvironmentId.make("a:b");
    const environmentA = EnvironmentId.make("a");
    const cards = buildBoardCards({
      projects: [
        project({ environmentId: environmentAB, id: ProjectId.make("c"), title: "First" }),
        project({ environmentId: environmentA, id: ProjectId.make("b:c"), title: "Second" }),
      ],
      threads: [
        thread({ environmentId: environmentAB, projectId: ProjectId.make("c") }),
        thread({
          id: ThreadId.make("thread-2"),
          environmentId: environmentA,
          projectId: ProjectId.make("b:c"),
        }),
      ],
    });

    expect(cards.map((card) => card.projectTitle).toSorted()).toEqual(["First", "Second"]);
    expect(groupBoardCardsByProject(cards)).toHaveLength(2);
  });
});

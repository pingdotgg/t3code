import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  orderProjects,
  orderProjectsByIds,
  projectOrdersEqual,
  shouldClearOptimisticProjectOrder,
  reorderProjectOrder,
} from "./projectOrder";
import { type Project } from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
    threadGroupOrder: [],
    sortOrder: 0,
    ...overrides,
  };
}

describe("projectOrder", () => {
  it("supports an optimistic project order override while preserving unknown projects", () => {
    const ordered = orderProjectsByIds(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-a"),
          cwd: "/tmp/project-a",
          sortOrder: 0,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-b"),
          cwd: "/tmp/project-b",
          sortOrder: 1,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-c"),
          cwd: "/tmp/project-c",
          sortOrder: 2,
        }),
      ],
      [ProjectId.makeUnsafe("project-c"), ProjectId.makeUnsafe("project-a")],
    );

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-c"),
      ProjectId.makeUnsafe("project-a"),
      ProjectId.makeUnsafe("project-b"),
    ]);
  });

  it("compares project order arrays by position", () => {
    expect(
      projectOrdersEqual(
        [ProjectId.makeUnsafe("project-a"), ProjectId.makeUnsafe("project-b")],
        [ProjectId.makeUnsafe("project-a"), ProjectId.makeUnsafe("project-b")],
      ),
    ).toBe(true);
    expect(
      projectOrdersEqual(
        [ProjectId.makeUnsafe("project-a"), ProjectId.makeUnsafe("project-b")],
        [ProjectId.makeUnsafe("project-b"), ProjectId.makeUnsafe("project-a")],
      ),
    ).toBe(false);
  });

  it("keeps the optimistic order until the project reorder queue has drained", () => {
    expect(
      shouldClearOptimisticProjectOrder({
        optimisticOrder: [
          ProjectId.makeUnsafe("project-c"),
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
        ],
        persistedOrder: [
          ProjectId.makeUnsafe("project-c"),
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
        ],
        hasPendingReorder: true,
      }),
    ).toBe(false);

    expect(
      shouldClearOptimisticProjectOrder({
        optimisticOrder: [
          ProjectId.makeUnsafe("project-c"),
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
        ],
        persistedOrder: [
          ProjectId.makeUnsafe("project-c"),
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
        ],
        hasPendingReorder: false,
      }),
    ).toBe(true);
  });

  it("sorts projects by shared sort order before creation order", () => {
    const ordered = orderProjects([
      makeProject({
        id: ProjectId.makeUnsafe("project-b"),
        name: "Project B",
        cwd: "/tmp/project-b",
        sortOrder: 2,
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-a"),
        name: "Project A",
        cwd: "/tmp/project-a",
        sortOrder: 0,
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-c"),
        name: "Project C",
        cwd: "/tmp/project-c",
        sortOrder: 1,
      }),
    ]);

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-a"),
      ProjectId.makeUnsafe("project-c"),
      ProjectId.makeUnsafe("project-b"),
    ]);
  });

  it("reorders projects by moving one project before another", () => {
    expect(
      reorderProjectOrder({
        currentOrder: [
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
          ProjectId.makeUnsafe("project-c"),
        ],
        movedProjectId: ProjectId.makeUnsafe("project-c"),
        beforeProjectId: ProjectId.makeUnsafe("project-a"),
      }),
    ).toEqual([
      ProjectId.makeUnsafe("project-c"),
      ProjectId.makeUnsafe("project-a"),
      ProjectId.makeUnsafe("project-b"),
    ]);
  });

  it("supports dropping a project at the end of the list", () => {
    expect(
      reorderProjectOrder({
        currentOrder: [
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
          ProjectId.makeUnsafe("project-c"),
        ],
        movedProjectId: ProjectId.makeUnsafe("project-a"),
        beforeProjectId: null,
      }),
    ).toEqual([
      ProjectId.makeUnsafe("project-b"),
      ProjectId.makeUnsafe("project-c"),
      ProjectId.makeUnsafe("project-a"),
    ]);
  });
});

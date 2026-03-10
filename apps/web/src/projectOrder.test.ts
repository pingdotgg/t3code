import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
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
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-b"),
          cwd: "/tmp/project-b",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-c"),
          cwd: "/tmp/project-c",
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

  it("clears the optimistic order after the live project order catches up", () => {
    expect(
      shouldClearOptimisticProjectOrder({
        optimisticOrder: [
          ProjectId.makeUnsafe("project-c"),
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
        ],
        currentOrder: [
          ProjectId.makeUnsafe("project-c"),
          ProjectId.makeUnsafe("project-a"),
          ProjectId.makeUnsafe("project-b"),
        ],
      }),
    ).toBe(true);
  });

  it("preserves the current project order when there is no override", () => {
    const ordered = orderProjectsByIds(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-b"),
          name: "Project B",
          cwd: "/tmp/project-b",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-a"),
          name: "Project A",
          cwd: "/tmp/project-a",
        }),
      ],
      null,
    );

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-b"),
      ProjectId.makeUnsafe("project-a"),
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

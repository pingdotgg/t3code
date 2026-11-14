import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectRailTiles,
  folderEditPlan,
  nextProjectRailScope,
  railOrderAfterMove,
  railKeysAfterFolderEdit,
  resolveProjectRailTileStates,
} from "./ProjectRail.logic";

const environmentId = EnvironmentId.make("environment-local");

function group(name: string, memberKeys: readonly string[] = [`physical:${name}`]) {
  return {
    projectKey: `group:${name}`,
    memberProjects: memberKeys.map((physicalProjectKey) => ({
      physicalProjectKey,
      workspaceRoot: `/work/${name}`,
    })),
    memberProjectRefs: [{ environmentId, projectId: ProjectId.make(name) }],
  } as unknown as Parameters<typeof buildProjectRailTiles>[0]["groups"][number];
}

function tiles(
  groups: readonly ReturnType<typeof group>[],
  threads: readonly { tags?: readonly string[] }[] = [],
  order: {
    projectOrder?: readonly string[];
    railOrder?: readonly string[];
    selectedKeys?: readonly string[];
  } = {},
) {
  return buildProjectRailTiles({
    groups,
    threads,
    selectedKeys: order.selectedKeys ?? [],
    projectOrder: order.projectOrder ?? [],
    railOrder: order.railOrder ?? [],
  });
}

function thread(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    environmentId,
    projectId: ProjectId.make(projectId),
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    lastVisitedAt: undefined,
    ...overrides,
  } as unknown as Parameters<typeof resolveProjectRailTileStates>[1][number];
}

describe("project rail tiles and order", () => {
  it("lists projects in the manual order, then one folder per tag", () => {
    const groups = [group("a"), group("b"), group("c", ["physical:c1", "physical:c2"])];
    const built = tiles(groups, [{ tags: ["zeta", "alpha"] }, { tags: ["alpha"] }, {}], {
      projectOrder: ["physical:c2", "physical:a"],
      // A chosen folder no thread carries any more keeps a tile, so its filter can be undone.
      selectedKeys: ["tag:gone", "group:a"],
    });
    expect(built.map((tile) => tile.key)).toEqual([
      "group:c",
      "group:a",
      "group:b",
      "tag:alpha",
      "tag:gone",
      "tag:zeta",
    ]);
  });

  it("drags across projects and folders, and keeps the project order in step", () => {
    const groups = [group("a"), group("b", ["physical:b1", "physical:b2"])];
    const built = tiles(groups, [{ tags: ["ops"] }]);
    const moved = railOrderAfterMove(built, "tag:ops", "group:a");
    expect(moved).toEqual({
      railOrder: ["tag:ops", "group:a", "group:b"],
      projectOrder: ["physical:a", "physical:b1", "physical:b2"],
    });
    expect(railOrderAfterMove(built, "group:a", "group:a")).toBeNull();

    // A tile the rail order never saw keeps its place after the ordered ones.
    const reread = tiles([...groups, group("c")], [{ tags: ["ops"] }, { tags: ["new"] }], {
      railOrder: moved!.railOrder,
    });
    expect(reread.map((tile) => tile.key)).toEqual([
      "tag:ops",
      "group:a",
      "group:b",
      "group:c",
      "tag:new",
    ]);
  });
});

describe("nextProjectRailScope", () => {
  it.each([
    { current: [], key: "a", additive: false, next: ["a"] },
    { current: ["a"], key: "a", additive: false, next: [] },
    { current: ["a", "b"], key: "a", additive: false, next: ["a"] },
    { current: ["a"], key: "b", additive: true, next: ["a", "b"] },
    { current: ["a", "b"], key: "a", additive: true, next: ["b"] },
  ])("$current + $key (additive: $additive) shows $next", ({ current, key, additive, next }) => {
    expect(nextProjectRailScope(current, key, additive)).toEqual(next);
  });
});

describe("resolveProjectRailTileStates", () => {
  it("marks a project idle only when every thread is settled or still snoozed", () => {
    const now = "2026-11-14T12:00:00.000Z";
    const states = resolveProjectRailTileStates(
      tiles([group("settled"), group("snoozed"), group("woke"), group("live"), group("empty")]),
      [
        thread("settled", { settledOverride: "settled" }),
        thread("snoozed", { snoozedUntil: "2026-11-15T00:00:00.000Z" }),
        thread("woke", { snoozedUntil: "2026-11-14T00:00:00.000Z" }),
        thread("live"),
      ],
      now,
    );
    expect(Object.fromEntries([...states].map(([key, state]) => [key, state.idle]))).toEqual({
      "group:settled": true,
      "group:snoozed": true,
      "group:woke": false,
      "group:live": false,
      "group:empty": true,
    });
  });

  it("keeps a project that needs you off the idle list", () => {
    const states = resolveProjectRailTileStates(
      tiles([group("asks")]),
      [thread("asks", { settledOverride: "settled", hasPendingApprovals: true })],
      "2026-11-14T12:00:00.000Z",
    );
    expect(states.get("group:asks")).toEqual({ dot: "attention", idle: false });
  });

  it("counts a tagged thread in its folders and not in its project", () => {
    const threads = [
      thread("a", { tags: ["ops"], hasPendingApprovals: true }),
      thread("a", { settledOverride: "settled" }),
      thread("b", { tags: ["ops", "docs"], settledOverride: "settled" }),
    ];
    const states = resolveProjectRailTileStates(
      tiles([group("a"), group("b")], threads),
      threads,
      "2026-11-14T12:00:00.000Z",
    );
    expect(Object.fromEntries(states)).toEqual({
      "group:a": { dot: null, idle: true },
      "group:b": { dot: null, idle: true },
      "tag:docs": { dot: null, idle: true },
      "tag:ops": { dot: "attention", idle: false },
    });
  });
});

describe("folder rename and delete", () => {
  const threads = [
    { id: "a", tags: ["ops"] },
    { id: "b", tags: ["ops", "infra"] },
    { id: "c", tags: ["infra"] },
    { id: "d" },
  ];
  const plan = (to: string | null) =>
    folderEditPlan(threads, "ops", to).map(({ thread, changes }) => ({ id: thread.id, changes }));

  it("renames by adding the new tag before removing the old one, merging into an existing folder", () => {
    expect(plan("infra")).toEqual([
      {
        id: "a",
        changes: [
          { tag: "infra", tagged: true },
          { tag: "ops", tagged: false },
        ],
      },
      { id: "b", changes: [{ tag: "ops", tagged: false }] },
    ]);
    expect(plan("ops")).toEqual([]);
  });

  it("deletes by removing the tag from every thread in the folder", () => {
    expect(plan(null)).toEqual([
      { id: "a", changes: [{ tag: "ops", tagged: false }] },
      { id: "b", changes: [{ tag: "ops", tagged: false }] },
    ]);
  });

  it("keeps a renamed folder's rail place and drops a deleted one", () => {
    const keys = ["group:a", "tag:ops", "tag:infra"];
    expect(railKeysAfterFolderEdit(keys, "ops", "build")).toEqual([
      "group:a",
      "tag:build",
      "tag:infra",
    ]);
    // Merging keeps the target folder's own place.
    expect(railKeysAfterFolderEdit(["tag:infra", "group:a", "tag:ops"], "ops", "infra")).toEqual([
      "tag:infra",
      "group:a",
    ]);
    expect(railKeysAfterFolderEdit(keys, "ops", null)).toEqual(["group:a", "tag:infra"]);
  });
});

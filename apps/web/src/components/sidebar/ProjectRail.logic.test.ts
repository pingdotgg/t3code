import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextProjectRailScope,
  orderProjectRailGroups,
  projectOrderAfterRailMove,
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
  } as unknown as Parameters<typeof orderProjectRailGroups>[0][number];
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

describe("project rail order", () => {
  it("keeps the manual order and moves a dropped tile to the target's place", () => {
    const groups = [group("a"), group("b"), group("c", ["physical:c1", "physical:c2"])];
    const ordered = orderProjectRailGroups(groups, ["physical:c2", "physical:a"]);
    expect(ordered.map((g) => g.projectKey)).toEqual(["group:c", "group:a", "group:b"]);

    expect(projectOrderAfterRailMove(ordered, "group:b", "group:c")).toEqual([
      "physical:b",
      "physical:c1",
      "physical:c2",
      "physical:a",
    ]);
    expect(projectOrderAfterRailMove(ordered, "group:a", "group:a")).toBeNull();
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
      [group("settled"), group("snoozed"), group("woke"), group("live"), group("empty")],
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
      [group("asks")],
      [thread("asks", { settledOverride: "settled", hasPendingApprovals: true })],
      "2026-11-14T12:00:00.000Z",
    );
    expect(states.get("group:asks")).toEqual({ dot: "attention", idle: false });
  });
});

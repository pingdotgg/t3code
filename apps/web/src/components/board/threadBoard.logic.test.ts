import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadStatus } from "../Sidebar.logic";
import {
  buildBoardSwimlanes,
  resolveBoardArrowTarget,
  resolveBoardLane,
  type BoardLane,
  type BoardSwimlaneCard,
} from "./threadBoard.logic";

describe("resolveBoardLane", () => {
  it.each<[SidebarThreadStatus, BoardLane]>([
    ["approval", "needs"],
    ["input", "needs"],
    ["request", "needs"],
    ["limited", "needs"],
    ["failed", "needs"],
    ["preparing", "working"],
    ["working", "working"],
    ["waiting", "working"],
    ["ready", "done"],
  ])("puts a %s thread in %s", (status, lane) => {
    expect(resolveBoardLane({ status, pullRequestChecksFailing: false })).toBe(lane);
  });

  it("moves a finished thread whose pull request checks fail to Needs you", () => {
    expect(resolveBoardLane({ status: "ready", pullRequestChecksFailing: true })).toBe("needs");
  });
});

describe("buildBoardSwimlanes", () => {
  const environmentId = EnvironmentId.make("env");
  const group = (name: string) => ({
    projectKey: name,
    memberProjectRefs: [{ environmentId, projectId: ProjectId.make(name) }],
  });
  const card = (project: string, lane: BoardLane, minute: number, id = `${project}-${minute}`) => ({
    id,
    lane,
    activityAt: `2026-11-25T10:${String(minute).padStart(2, "0")}:00.000Z`,
    thread: { environmentId, projectId: ProjectId.make(project) },
  });
  const ids = (cards: ReadonlyArray<BoardSwimlaneCard & { id: string }>) => cards.map((c) => c.id);

  it("puts projects with a Needs-you card first and keeps sidebar order otherwise", () => {
    const swimlanes = buildBoardSwimlanes(
      [group("alpha"), group("beta"), group("gamma"), group("empty")],
      [card("alpha", "done", 1), card("beta", "working", 2), card("gamma", "needs", 3)],
    );
    expect(swimlanes.map((swimlane) => swimlane.group.projectKey)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
  });

  it("orders Needs you oldest first and the other lanes newest first", () => {
    const [swimlane] = buildBoardSwimlanes(
      [group("alpha")],
      [
        card("alpha", "needs", 5),
        card("alpha", "needs", 1),
        card("alpha", "done", 1),
        card("alpha", "done", 5),
      ],
    );
    expect(ids(swimlane!.lanes.needs)).toEqual(["alpha-1", "alpha-5"]);
    expect(ids(swimlane!.lanes.done)).toEqual(["alpha-5", "alpha-1"]);
  });

  it("drops cards whose project is not in any group", () => {
    expect(buildBoardSwimlanes([group("alpha")], [card("stray", "done", 1)])).toEqual([]);
  });
});

describe("resolveBoardArrowTarget", () => {
  // Two swimlanes; lanes are Needs you, Working, Done.
  const grid = [
    [["a1", "a2"], [], ["a3"]],
    [["b1"], ["b2", "b3"], []],
  ];

  it("walks a lane down and up across swimlanes", () => {
    expect(resolveBoardArrowTarget(grid, "a1", "ArrowDown")).toBe("a2");
    expect(resolveBoardArrowTarget(grid, "a2", "ArrowDown")).toBe("b1");
    expect(resolveBoardArrowTarget(grid, "b1", "ArrowUp")).toBe("a2");
    expect(resolveBoardArrowTarget(grid, "b1", "ArrowDown")).toBeNull();
  });

  it("skips empty lanes sideways and keeps the row position when it can", () => {
    expect(resolveBoardArrowTarget(grid, "a2", "ArrowRight")).toBe("a3");
    expect(resolveBoardArrowTarget(grid, "a3", "ArrowLeft")).toBe("a1");
    expect(resolveBoardArrowTarget(grid, "b1", "ArrowRight")).toBe("b2");
    expect(resolveBoardArrowTarget(grid, "b3", "ArrowRight")).toBeNull();
  });

  it("returns null for a card that is not on the board", () => {
    expect(resolveBoardArrowTarget(grid, "gone", "ArrowDown")).toBeNull();
  });
});
